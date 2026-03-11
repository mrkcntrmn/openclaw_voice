import { loadChatHistory } from "./chat.ts";
import type { GatewayBrowserClient } from "../gateway.ts";
import type { UiSettings } from "../storage.ts";
import { AudioCapture } from "./audio-capture.ts";
import { AudioPlayback } from "./audio-playback.ts";

const DEFAULT_VOICE_WS_PATH = "/voice/ws";
const DEFAULT_SAMPLE_RATE_HZ = 16_000;
const DEFAULT_FRAME_DURATION_MS = 20;

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

type VoiceConfigResponse = {
  config?: {
    voice?: {
      provider?: string;
      browser?: {
        enabled?: boolean;
        channels?: number;
        vad?: string;
      };
      session?: {
        sharedChatHistory?: boolean;
      };
      resolved?: {
        provider?: string;
      };
      deprecations?: string[];
    };
  };
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
  voiceAvailable: boolean;
  voiceAvailabilityReason: string | null;
  voiceConfigLoading: boolean;
  voiceConfigProvider: string | null;
  voiceDeprecations: string[];
  voiceConnecting: boolean;
  voiceConnected: boolean;
  voiceStatus: string | null;
  voiceError: string | null;
  voiceUserTranscript: string | null;
  voiceAssistantTranscript: string | null;
  voiceSessionKey: string | null;
  voiceProvider: string | null;
  voiceVolume: number;
  voiceHandle: VoiceSessionHandle | null;
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
    // eslint-disable-next-line @typescript-eslint/unbound-method
    Boolean(navigator.mediaDevices && navigator.mediaDevices.getUserMedia)
  );
}

type VoicePreflightState = {
  available: boolean;
  reason: string | null;
  provider: string | null;
  deprecations: string[];
};

function normalizeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => normalizeString(entry))
    .filter((entry): entry is string => Boolean(entry));
}

function mergeVoiceDeprecations(existing: string[], incoming: string[]): string[] {
  const merged = new Set<string>();
  for (const entry of [...existing, ...incoming]) {
    const normalized = normalizeString(entry);
    if (normalized) {
      merged.add(normalized);
    }
  }
  return [...merged];
}

function resolveVoicePreflightState(response: VoiceConfigResponse | null): VoicePreflightState {
  const voice = isRecord(response?.config?.voice)
    ? response?.config?.voice
    : null;
  const provider =
    normalizeString(voice?.resolved?.provider) ?? normalizeString(voice?.provider) ?? null;
  const deprecations = mergeVoiceDeprecations([], normalizeStringList(voice?.deprecations));

  if (!voice) {
    return {
      available: false,
      reason: "Browser voice is not configured in the current gateway config.",
      provider: null,
      deprecations,
    };
  }

  const browser = isRecord(voice.browser) ? voice.browser : null;
  const session = isRecord(voice.session) ? voice.session : null;
  const channels = typeof browser?.channels === "number" ? browser.channels : 1;
  const vad = normalizeString(browser?.vad) ?? "provider";
  const sharedChatHistory =
    typeof session?.sharedChatHistory === "boolean" ? session.sharedChatHistory : true;

  if (browser?.enabled === false) {
    return {
      available: false,
      reason: "Browser voice is disabled in the current gateway config.",
      provider,
      deprecations,
    };
  }
  if (channels !== 1) {
    return {
      available: false,
      reason: "voice.browser.channels must be 1 for browser voice",
      provider,
      deprecations,
    };
  }
  if (vad !== "provider") {
    return {
      available: false,
      reason: 'voice.browser.vad must be "provider" for browser voice',
      provider,
      deprecations,
    };
  }
  if (!sharedChatHistory) {
    return {
      available: false,
      reason: "voice.session.sharedChatHistory must be true for browser voice",
      provider,
      deprecations,
    };
  }

  return {
    available: true,
    reason: null,
    provider,
    deprecations,
  };
}

export async function refreshVoiceConfig(host: VoiceHost): Promise<void> {
  if (!host.client || !host.connected) {
    host.voiceConfigLoading = false;
    host.voiceAvailable = false;
    host.voiceAvailabilityReason = null;
    host.voiceConfigProvider = null;
    host.voiceDeprecations = [];
    return;
  }

  host.voiceConfigLoading = true;
  try {
    const response = await host.client.request<VoiceConfigResponse>("voice.config", {});
    const preflight = resolveVoicePreflightState(isRecord(response) ? response : null);
    host.voiceAvailable = preflight.available;
    host.voiceAvailabilityReason = preflight.reason;
    host.voiceConfigProvider = preflight.provider;
    host.voiceDeprecations = preflight.deprecations;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    host.voiceAvailable = false;
    host.voiceAvailabilityReason = "Unable to load voice config: " + message;
    host.voiceConfigProvider = null;
    host.voiceDeprecations = [];
  } finally {
    host.voiceConfigLoading = false;
  }
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

async function createVoiceSessionBootstrap(host: VoiceHost): Promise<VoiceSessionBootstrapResponse | null> {
  if (!host.client) {
    return null;
  }
  const response = await host.client.request<VoiceSessionBootstrapResponse>("voice.session.create", {
    ...(normalizeString(host.sessionKey) ? { sessionKey: normalizeString(host.sessionKey) } : {}),
    ...(normalizeString(host.assistantAgentId) ? { agentId: normalizeString(host.assistantAgentId) } : {}),
  });
  return isRecord(response) ? response : null;
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
  host.voiceVolume = 0;
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
  if (host.voiceConfigLoading) {
    host.voiceError = "Checking browser voice configuration. Retry in a moment.";
    return;
  }
  if (!host.voiceAvailable) {
    host.voiceError =
      host.voiceAvailabilityReason ?? "Browser voice is unavailable in the current gateway config.";
    return;
  }

  host.voiceConnecting = true;
  host.voiceError = null;
  host.voiceStatus = "Preparing voice session";
  host.voiceUserTranscript = null;
  host.voiceAssistantTranscript = null;
  host.voiceVolume = 0;

  let capture: AudioCapture | null = null;
  let playback: AudioPlayback | null = null;
  let ws: WebSocket | null = null;
  let streamAudioEnabled = false;
  let closing = false;
  const refreshTimer = { value: null as number | null };

  const teardown = async (params?: { preserveError?: boolean; skipSocketClose?: boolean }) => {
    if (closing) {
      return;
    }
    closing = true;
    streamAudioEnabled = false;

    resetVoiceState(host, params?.preserveError === true);

    if (refreshTimer.value !== null) {
      window.clearTimeout(refreshTimer.value);
      refreshTimer.value = null;
    }

    if (capture) {
      await capture.stop();
    }

    if (playback) {
      playback.stop();
    }

    if (ws && !params?.skipSocketClose) {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        try { ws.close(1000, "voice stop"); } catch {}
      }
    }
  };

  try {
    const bootstrap = await createVoiceSessionBootstrap(host);
    if (!bootstrap) {
      throw new Error("voice.session.create returned no voice session bootstrap");
    }

    host.voiceDeprecations = mergeVoiceDeprecations(
      host.voiceDeprecations,
      normalizeStringList(bootstrap.deprecations),
    );

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

    host.voiceStatus = "Requesting microphone";
    
    capture = new AudioCapture({
      sampleRateHz,
      frameDurationMs,
      onAudioData: (data) => {
        if (streamAudioEnabled && ws && ws.readyState === WebSocket.OPEN) {
          ws.send(data);
        }
      },
      onVolumeChange: (volume) => {
        host.voiceVolume = volume;
      },
    });
    await capture.start();

    playback = new AudioPlayback(sampleRateHz);
    playback.start();

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
          playback.interrupt();
        }
        ws.send(JSON.stringify({ type: "interrupt" }));
      },
    };
    host.voiceHandle = voiceHandle;

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
              playback.interrupt();
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
        playback.enqueue(event.data);
        return;
      }
      if (event.data instanceof Blob) {
        void event.data.arrayBuffer().then((payload) => playback!.enqueue(payload));
      }
    });

    ws.addEventListener("close", (event) => {
      const preserveExistingError = !closing && Boolean(host.voiceError);
      const shouldReportError = !closing && event.code !== 1000;
      if (shouldReportError && !host.voiceError) {
        host.voiceError = "Voice disconnected (" + event.code + "): " + (event.reason || "no reason");
      }
      void teardown({
        preserveError: preserveExistingError || shouldReportError,
        skipSocketClose: true,
      });
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
