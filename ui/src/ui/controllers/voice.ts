import { loadChatHistory } from "./chat.ts";
import type { GatewayBrowserClient } from "../gateway.ts";
import type { UiSettings } from "../storage.ts";

const DEFAULT_VOICE_WS_PATH = "/voice/ws";
const DEFAULT_SAMPLE_RATE_HZ = 16_000;
const DEFAULT_FRAME_DURATION_MS = 20;
const READY_LATENCY_PADDING_SEC = 0.03;
const CAPTURE_WORKLET_NAME = "openclaw-pcm16-capture";
const loadedWorkletContexts = new WeakSet<AudioContext>();

const CAPTURE_WORKLET_SOURCE = `
class OpenClawPcm16CaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const processorOptions = options?.processorOptions ?? {};
    this.targetSampleRate =
      typeof processorOptions.targetSampleRate === "number"
        ? processorOptions.targetSampleRate
        : 16000;
    this.frameDurationMs =
      typeof processorOptions.frameDurationMs === "number"
        ? processorOptions.frameDurationMs
        : 20;
    this.frameSamples = Math.max(1, Math.round((this.targetSampleRate * this.frameDurationMs) / 1000));
    this.sourceToTargetRatio = sampleRate / this.targetSampleRate;
    this.pendingPosition = 0;
    this.pendingAccumulator = 0;
    this.pendingCount = 0;
    this.frame = [];
  }

  process(inputs, outputs) {
    const output = outputs?.[0];
    if (output) {
      for (const channel of output) {
        channel.fill(0);
      }
    }

    const input = inputs?.[0]?.[0];
    if (!input || input.length === 0) {
      return true;
    }

    for (let index = 0; index < input.length; index += 1) {
      this.pendingAccumulator += input[index];
      this.pendingCount += 1;
      this.pendingPosition += 1;
      if (this.pendingPosition < this.sourceToTargetRatio) {
        continue;
      }

      const averagedSample = this.pendingCount > 0 ? this.pendingAccumulator / this.pendingCount : 0;
      this.pendingAccumulator = 0;
      this.pendingCount = 0;
      this.pendingPosition -= this.sourceToTargetRatio;
      const clamped = Math.max(-1, Math.min(1, averagedSample));
      const pcmSample = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
      this.frame.push(Math.max(-32768, Math.min(32767, Math.round(pcmSample))));

      if (this.frame.length < this.frameSamples) {
        continue;
      }

      const payload = new Int16Array(this.frame);
      this.frame = [];
      this.port.postMessage(payload.buffer, [payload.buffer]);
    }

    return true;
  }
}

registerProcessor("${CAPTURE_WORKLET_NAME}", OpenClawPcm16CaptureProcessor);
`;

type VoiceSessionBootstrapResponse = {
  ticket?: string;
  expiresAt?: number;
  sessionKey?: string;
  provider?: string;
  modelId?: string;
  transport?: {
    wsPath?: string;
    sampleRateHz?: number;
    channels?: number;
    frameDurationMs?: number;
  };
  session?: {
    interruptOnSpeech?: boolean;
    pauseOnToolCall?: boolean;
    persistTranscripts?: boolean;
    transcriptSource?: string;
    silenceTimeoutMs?: number;
    sharedChatHistory?: boolean;
    sessionKeyPrefix?: string;
  };
  deprecations?: string[];
};

type VoiceServerControlFrame =
  | {
      type: "ready";
      sessionKey?: string;
      provider?: string;
      modelId?: string;
    }
  | { type: "state"; state?: string; detail?: string }
  | { type: "transcript"; role?: string; text?: string; final?: boolean }
  | { type: "tool_call"; name?: string }
  | { type: "tool_result"; name?: string }
  | { type: "error"; message?: string }
  | { type: "pong" };

export type VoiceSessionHandle = {
  close: (opts?: { preserveError?: boolean }) => Promise<void>;
  interrupt: () => void;
};

type VoiceHost = {
  settings: UiSettings;
  password: string;
  client: GatewayBrowserClient | null;
  connected: boolean;
  sessionKey: string;
  assistantAgentId: string | null;
  chatLoading: boolean;
  chatMessages: unknown[];
  chatThinkingLevel: string | null;
  chatStream: string | null;
  chatStreamStartedAt: number | null;
  lastError: string | null;
  voiceSupported: boolean;
  voiceConnecting: boolean;
  voiceConnected: boolean;
  voiceStatus: string | null;
  voiceError: string | null;
  voiceUserTranscript: string | null;
  voiceAssistantTranscript: string | null;
  voiceSessionKey: string | null;
  voiceProvider: string | null;
  voiceHandle: VoiceSessionHandle | null;
};

type PlaybackState = {
  context: AudioContext;
  gain: GainNode;
  sources: Set<AudioBufferSourceNode>;
  nextStartTime: number;
  sampleRateHz: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function resolveVoiceSupport(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof AudioContext !== "undefined" &&
    typeof AudioWorkletNode !== "undefined" &&
    typeof WebSocket !== "undefined" &&
    typeof navigator !== "undefined" &&
    Boolean(navigator.mediaDevices?.getUserMedia)
  );
}

function formatVoiceStatus(state: string | null, detail: string | null): string {
  switch (state) {
    case "connecting":
      return "Connecting";
    case "connected":
      return "Ready";
    case "listening":
      return "Listening";
    case "responding":
      return detail ? `Responding (${detail})` : "Responding";
    case "tool":
      return detail ? `Tool: ${detail}` : "Tool running";
    case "closed":
      return "Disconnected";
    default:
      return detail ? `${state ?? "voice"}: ${detail}` : state ?? "Idle";
  }
}

function buildVoiceWebSocketUrl(gatewayUrl: string, wsPath: string): string {
  const base = new URL(gatewayUrl, window.location.href);
  if (base.protocol === "http:") {
    base.protocol = "ws:";
  } else if (base.protocol === "https:") {
    base.protocol = "wss:";
  } else if (base.protocol !== "ws:" && base.protocol !== "wss:") {
    base.protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  }
  base.pathname = wsPath.startsWith("/") ? wsPath : `/${wsPath}`;
  base.search = "";
  base.hash = "";
  return base.toString();
}

async function ensureCaptureWorklet(context: AudioContext): Promise<void> {
  if (loadedWorkletContexts.has(context)) {
    return;
  }
  const blob = new Blob([CAPTURE_WORKLET_SOURCE], { type: "application/javascript" });
  const moduleUrl = URL.createObjectURL(blob);
  try {
    await context.audioWorklet.addModule(moduleUrl);
    loadedWorkletContexts.add(context);
  } finally {
    URL.revokeObjectURL(moduleUrl);
  }
}

function createPlaybackState(context: AudioContext, sampleRateHz: number): PlaybackState {
  const gain = context.createGain();
  gain.gain.value = 1;
  gain.connect(context.destination);
  return {
    context,
    gain,
    sources: new Set<AudioBufferSourceNode>(),
    nextStartTime: context.currentTime + READY_LATENCY_PADDING_SEC,
    sampleRateHz,
  };
}

function stopPlayback(playback: PlaybackState): void {
  for (const source of playback.sources) {
    try {
      source.stop();
    } catch {
      // Ignore already-ended nodes.
    }
    source.disconnect();
  }
  playback.sources.clear();
  playback.nextStartTime = playback.context.currentTime + READY_LATENCY_PADDING_SEC;
}

function enqueuePlaybackChunk(playback: PlaybackState, payload: ArrayBuffer): void {
  if (payload.byteLength < 2) {
    return;
  }
  const sampleCount = Math.floor(payload.byteLength / 2);
  if (sampleCount < 1) {
    return;
  }
  const pcm = new Int16Array(payload, 0, sampleCount);
  const normalized = new Float32Array(pcm.length);
  for (let index = 0; index < pcm.length; index += 1) {
    normalized[index] = pcm[index] / 0x8000;
  }

  const audioBuffer = playback.context.createBuffer(1, normalized.length, playback.sampleRateHz);
  audioBuffer.copyToChannel(normalized, 0);

  const source = playback.context.createBufferSource();
  source.buffer = audioBuffer;
  source.connect(playback.gain);
  source.addEventListener("ended", () => {
    playback.sources.delete(source);
    source.disconnect();
  });

  const startTime = Math.max(playback.context.currentTime + READY_LATENCY_PADDING_SEC, playback.nextStartTime);
  source.start(startTime);
  playback.nextStartTime = startTime + audioBuffer.duration;
  playback.sources.add(source);
}

async function createVoiceSessionBootstrap(host: VoiceHost): Promise<VoiceSessionBootstrapResponse | null> {
  if (!host.client) {
    return null;
  }
  const response = await host.client.request<VoiceSessionBootstrapResponse>("voice.session.create", {
    ...(normalizeString(host.sessionKey) ? { sessionKey: normalizeString(host.sessionKey) } : {}),
    ...(normalizeString(host.assistantAgentId) ? { agentId: normalizeString(host.assistantAgentId) } : {}),
  });
  return isRecord(response) ? (response as VoiceSessionBootstrapResponse) : null;
}

function scheduleHistoryRefresh(host: VoiceHost, timerRef: { value: number | null }) {
  if (timerRef.value !== null) {
    window.clearTimeout(timerRef.value);
  }
  timerRef.value = window.setTimeout(() => {
    timerRef.value = null;
    void loadChatHistory(host as unknown as Parameters<typeof loadChatHistory>[0]);
  }, 180);
}

function resetVoiceState(host: VoiceHost, preserveError = false): void {
  host.voiceHandle = null;
  host.voiceConnecting = false;
  host.voiceConnected = false;
  host.voiceStatus = null;
  host.voiceSessionKey = null;
  host.voiceProvider = null;
  host.voiceUserTranscript = null;
  host.voiceAssistantTranscript = null;
  if (!preserveError) {
    host.voiceError = null;
  }
}

export async function handleVoiceConnect(host: VoiceHost): Promise<void> {
  if (host.voiceConnecting || host.voiceConnected) {
    return;
  }

  host.voiceSupported = resolveVoiceSupport();
  if (!host.voiceSupported) {
    host.voiceError = "Browser voice requires microphone access, Web Audio, and AudioWorklet support.";
    return;
  }
  if (!host.connected || !host.client) {
    host.voiceError = "Connect to the gateway before starting voice.";
    return;
  }

  host.voiceConnecting = true;
  host.voiceError = null;
  host.voiceStatus = "Requesting microphone";
  host.voiceUserTranscript = null;
  host.voiceAssistantTranscript = null;

  let audioContext: AudioContext | null = null;
  let mediaStream: MediaStream | null = null;
  let mediaSource: MediaStreamAudioSourceNode | null = null;
  let captureNode: AudioWorkletNode | null = null;
  let captureSink: GainNode | null = null;
  let ws: WebSocket | null = null;
  let playback: PlaybackState | null = null;
  let streamAudioEnabled = false;
  let closing = false;
  const refreshTimer = { value: null as number | null };

  const teardown = async (params?: { preserveError?: boolean; skipSocketClose?: boolean }) => {
    if (closing) {
      return;
    }
    closing = true;
    streamAudioEnabled = false;

    if (refreshTimer.value !== null) {
      window.clearTimeout(refreshTimer.value);
      refreshTimer.value = null;
    }

    if (captureNode) {
      captureNode.port.onmessage = null;
    }
    try { captureNode?.disconnect(); } catch {}
    try { mediaSource?.disconnect(); } catch {}
    try { captureSink?.disconnect(); } catch {}
    if (mediaStream) {
      for (const track of mediaStream.getTracks()) {
        track.stop();
      }
    }

    if (playback) {
      stopPlayback(playback);
      try { playback.gain.disconnect(); } catch {}
    }

    if (ws && !params?.skipSocketClose) {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        try { ws.close(1000, "voice stop"); } catch {}
      }
    }

    if (audioContext && audioContext.state !== "closed") {
      await audioContext.close().catch(() => {});
    }

    resetVoiceState(host, params?.preserveError === true);
  };

  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });

    host.voiceStatus = "Preparing voice session";
    const bootstrap = await createVoiceSessionBootstrap(host);
    if (!bootstrap) {
      throw new Error("voice.session.create returned no voice session bootstrap");
    }

    const ticket = normalizeString(bootstrap.ticket);
    if (!ticket) {
      throw new Error("voice.session.create returned no voice ticket");
    }

    const wsPath = normalizeString(bootstrap.transport?.wsPath) ?? DEFAULT_VOICE_WS_PATH;
    const sampleRateHz =
      typeof bootstrap.transport?.sampleRateHz === "number"
        ? bootstrap.transport.sampleRateHz
        : DEFAULT_SAMPLE_RATE_HZ;
    const frameDurationMs =
      typeof bootstrap.transport?.frameDurationMs === "number"
        ? bootstrap.transport.frameDurationMs
        : DEFAULT_FRAME_DURATION_MS;
    const providerId = normalizeString(bootstrap.provider) ?? "voice";
    const bootstrapSessionKey = normalizeString(bootstrap.sessionKey) ?? host.sessionKey;

    audioContext = new AudioContext();
    await audioContext.resume();
    await ensureCaptureWorklet(audioContext);
    playback = createPlaybackState(audioContext, sampleRateHz);

    mediaSource = audioContext.createMediaStreamSource(mediaStream);
    captureNode = new AudioWorkletNode(audioContext, CAPTURE_WORKLET_NAME, {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      processorOptions: {
        targetSampleRate: sampleRateHz,
        frameDurationMs,
      },
    });
    captureSink = audioContext.createGain();
    captureSink.gain.value = 0;
    mediaSource.connect(captureNode);
    captureNode.connect(captureSink);
    captureSink.connect(audioContext.destination);

    ws = new WebSocket(buildVoiceWebSocketUrl(host.settings.gatewayUrl, wsPath));
    ws.binaryType = "arraybuffer";

    const voiceHandle: VoiceSessionHandle = {
      close: async (opts) => {
        await teardown({ preserveError: opts?.preserveError === true });
      },
      interrupt: () => {
        if (!ws || ws.readyState !== WebSocket.OPEN) {
          return;
        }
        if (playback) {
          stopPlayback(playback);
        }
        ws.send(JSON.stringify({ type: "interrupt" }));
      },
    };
    host.voiceHandle = voiceHandle;

    captureNode.port.onmessage = (event: MessageEvent<ArrayBuffer>) => {
      if (!streamAudioEnabled || !ws || ws.readyState !== WebSocket.OPEN) {
        return;
      }
      if (event.data instanceof ArrayBuffer) {
        ws.send(event.data);
      }
    };

    ws.addEventListener("open", () => {
      host.voiceStatus = "Starting voice session";
      ws?.send(JSON.stringify({ type: "start", ticket }));
    });

    ws.addEventListener("message", (event) => {
      if (typeof event.data === "string") {
        let parsed: VoiceServerControlFrame | null = null;
        try {
          parsed = JSON.parse(event.data) as VoiceServerControlFrame;
        } catch {
          return;
        }
        if (!parsed || typeof parsed.type !== "string") {
          return;
        }
        switch (parsed.type) {
          case "ready": {
            host.voiceConnecting = false;
            host.voiceConnected = true;
            host.voiceProvider = normalizeString(parsed.provider) ?? providerId;
            host.voiceSessionKey = normalizeString(parsed.sessionKey) ?? bootstrapSessionKey;
            host.voiceStatus = "Listening";
            streamAudioEnabled = true;
            return;
          }
          case "state": {
            const nextState = normalizeString(parsed.state);
            const detail = normalizeString(parsed.detail);
            host.voiceStatus = formatVoiceStatus(nextState, detail);
            if (nextState === "listening" && playback) {
              stopPlayback(playback);
            }
            return;
          }
          case "transcript": {
            const role = normalizeString(parsed.role);
            const text = normalizeString(parsed.text);
            const final = parsed.final === true;
            if (!role || !text) {
              return;
            }
            if (role === "user") {
              host.voiceUserTranscript = text;
              if (!final) {
                host.voiceAssistantTranscript = null;
              }
            } else if (role === "assistant") {
              host.voiceAssistantTranscript = text;
            }
            if (final) {
              scheduleHistoryRefresh(host, refreshTimer);
            }
            return;
          }
          case "tool_call": {
            const name = normalizeString(parsed.name);
            host.voiceStatus = name ? `Tool: ${name}` : "Tool running";
            return;
          }
          case "tool_result": {
            const name = normalizeString(parsed.name);
            host.voiceStatus = name ? `Tool complete: ${name}` : "Tool complete";
            scheduleHistoryRefresh(host, refreshTimer);
            return;
          }
          case "error": {
            host.voiceError = normalizeString(parsed.message) ?? "Voice session error";
            return;
          }
          default:
            return;
        }
      }

      if (!playback) {
        return;
      }
      if (event.data instanceof ArrayBuffer) {
        enqueuePlaybackChunk(playback, event.data);
        return;
      }
      if (event.data instanceof Blob) {
        void event.data.arrayBuffer().then((payload) => enqueuePlaybackChunk(playback!, payload));
      }
    });

    ws.addEventListener("close", (event) => {
      const shouldReportError = !closing && event.code !== 1000;
      if (shouldReportError) {
        host.voiceError = `Voice disconnected (${event.code}): ${event.reason || "no reason"}`;
      }
      void teardown({ preserveError: shouldReportError, skipSocketClose: true });
    });

    ws.addEventListener("error", () => {
      host.voiceError = "Voice transport error";
    });
  } catch (error) {
    await teardown({ preserveError: true, skipSocketClose: true });
    const message = error instanceof Error ? error.message : String(error);
    host.voiceError = message;
    host.voiceStatus = null;
  }
}

export async function handleVoiceDisconnect(
  host: VoiceHost,
  opts?: { preserveError?: boolean },
): Promise<void> {
  if (!host.voiceHandle) {
    resetVoiceState(host, opts?.preserveError === true);
    return;
  }
  const handle = host.voiceHandle;
  host.voiceHandle = null;
  await handle.close({ preserveError: opts?.preserveError === true });
}

export function handleVoiceInterrupt(host: VoiceHost): void {
  host.voiceHandle?.interrupt();
}
