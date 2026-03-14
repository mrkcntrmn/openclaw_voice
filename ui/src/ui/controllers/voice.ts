import { loadChatHistory } from "./chat.ts";
import { extractText } from "../chat/message-extract.ts";
import type { GatewayBrowserClient } from "../gateway.ts";
import type { UiSettings } from "../storage.ts";
import { AudioCapture } from "./audio-capture.ts";
import { AudioPlayback } from "./audio-playback.ts";
import type { Pcm16AudioMetrics } from "./audio-capture-math.ts";
import {
  debugVoice,
  debugVoicePayload,
  voiceDebugElapsedMs,
} from "./voice-debug.ts";

const DEFAULT_VOICE_WS_PATH = "/voice/ws";
const DEFAULT_SAMPLE_RATE_HZ = 16_000;
const DEFAULT_FRAME_DURATION_MS = 20;
const VOICE_AUDIO_DEBUG_LOG_INTERVAL_MS = 250;
const VOICE_AUDIO_SILENCE_WARNING_FRAME_COUNT = 60;
const VOICE_AUDIO_SILENCE_RMS_THRESHOLD = 0.01;
const VOICE_AUDIO_ACTIVITY_VOLUME_THRESHOLD = 0.01;
const VOICE_NO_TRANSCRIPT_WARNING_MS = 5_000;

export type VoiceLiveTurn = {
  text: string;
  final: boolean;
  startedAt: number;
  updatedAt: number;
};

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
      transport?: {
        sampleRateHz?: number;
        channels?: number;
        frameDurationMs?: number;
      };
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
  voiceLiveUserTurn: VoiceLiveTurn | null;
  voiceLiveAssistantTurn: VoiceLiveTurn | null;
  voiceSessionKey: string | null;
  voiceProvider: string | null;
  voiceVolume: number;
  voiceHandle: VoiceSessionHandle | null;
  requestUpdate?: () => void;
};

function notifyVoiceHostUpdated(host: VoiceHost): void {
  host.requestUpdate?.();
}

function roundVoiceAudioMetric(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

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

function normalizeTranscriptText(value: unknown, final = false): string | null {
  if (typeof value !== "string") {
    return null;
  }
  if (final) {
    return normalizeString(value);
  }
  return value.length > 0 ? value : null;
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
  const startedAt = Date.now();
  debugVoice("voice config request", {
    connected: host.connected,
    hasClient: Boolean(host.client),
  });
  if (!host.client || !host.connected) {
    host.voiceConfigLoading = false;
    host.voiceAvailable = false;
    host.voiceAvailabilityReason = null;
    host.voiceConfigProvider = null;
    host.voiceDeprecations = [];
    debugVoice("voice config response", {
      available: false,
      reason: "client-unavailable",
      elapsedMs: voiceDebugElapsedMs(startedAt),
    });
    return;
  }

  host.voiceConfigLoading = true;
  try {
    const response = await host.client.request<VoiceConfigResponse>("voice.config", {});
    debugVoicePayload("voice config response payload", response);
    const preflight = resolveVoicePreflightState(isRecord(response) ? response : null);
    host.voiceAvailable = preflight.available;
    host.voiceAvailabilityReason = preflight.reason;
    host.voiceConfigProvider = preflight.provider;
    host.voiceDeprecations = preflight.deprecations;
    debugVoice("voice config response", {
      available: preflight.available,
      provider: preflight.provider,
      deprecationCount: preflight.deprecations.length,
      elapsedMs: voiceDebugElapsedMs(startedAt),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    host.voiceAvailable = false;
    host.voiceAvailabilityReason = "Unable to load voice config: " + message;
    host.voiceConfigProvider = null;
    host.voiceDeprecations = [];
    debugVoice("voice config response", {
      available: false,
      error: message,
      elapsedMs: voiceDebugElapsedMs(startedAt),
    });
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
  const startedAt = Date.now();
  const params = {
    ...(normalizeString(host.sessionKey) ? { sessionKey: normalizeString(host.sessionKey) } : {}),
    ...(normalizeString(host.assistantAgentId) ? { agentId: normalizeString(host.assistantAgentId) } : {}),
  };
  debugVoice("voice bootstrap request", params);
  const response = await host.client.request<VoiceSessionBootstrapResponse>("voice.session.create", params);
  debugVoice("voice bootstrap response", {
    sessionKey: normalizeString(response?.sessionKey),
    provider: normalizeString(response?.provider),
    modelId: normalizeString(response?.modelId),
    elapsedMs: voiceDebugElapsedMs(startedAt),
  });
  debugVoicePayload("voice bootstrap response payload", response);
  return isRecord(response) ? response : null;
}

type HistoryRefreshState = {
  timer: number | null;
  inFlight: boolean;
  pending: boolean;
  disposed: boolean;
};

type TranscriptBufferState = {
  user: string;
  assistant: string;
  userStartedAt: number | null;
  assistantStartedAt: number | null;
};

function isPersistedVoiceTurn(
  host: Pick<VoiceHost, "chatMessages">,
  role: "user" | "assistant",
  text: string,
): boolean {
  const normalizedText = text.trim();
  if (!normalizedText) {
    return false;
  }
  return host.chatMessages.some((message) => {
    if (!isRecord(message)) {
      return false;
    }
    const messageRole = normalizeString(message.role);
    if (messageRole !== role) {
      return false;
    }
    return extractText(message)?.trim() === normalizedText;
  });
}

function maybeClearSettledVoiceTurns(host: VoiceHost): void {
  let changed = false;
  if (
    host.voiceLiveUserTurn?.final &&
    isPersistedVoiceTurn(host, "user", host.voiceLiveUserTurn.text)
  ) {
    host.voiceLiveUserTurn = null;
    changed = true;
  }
  if (
    host.voiceLiveAssistantTurn?.final &&
    isPersistedVoiceTurn(host, "assistant", host.voiceLiveAssistantTurn.text)
  ) {
    host.voiceLiveAssistantTurn = null;
    changed = true;
  }
  if (changed) {
    notifyVoiceHostUpdated(host);
  }
}

function runHistoryRefresh(host: VoiceHost, refreshState: HistoryRefreshState): void {
  if (refreshState.disposed) {
    return;
  }
  const sessionKey = host.voiceSessionKey ?? host.sessionKey;
  if (refreshState.inFlight) {
    refreshState.pending = true;
    debugVoice("voice history refresh", {
      sessionKey,
      state: "coalesced",
    });
    return;
  }

  refreshState.inFlight = true;
  refreshState.pending = false;
  debugVoice("voice history refresh", {
    sessionKey,
    state: "running",
  });
  void loadChatHistory(host as unknown as Parameters<typeof loadChatHistory>[0], { sessionKey })
    .then(() => {
      maybeClearSettledVoiceTurns(host);
      debugVoice("voice history refresh", {
        sessionKey,
        state: "complete",
      });
    })
    .catch((error) => {
      debugVoice("voice history refresh", {
        sessionKey,
        state: "error",
        error: error instanceof Error ? error.message : String(error),
      });
    })
    .finally(() => {
      refreshState.inFlight = false;
      if (refreshState.pending && !refreshState.disposed) {
        refreshState.pending = false;
        runHistoryRefresh(host, refreshState);
      }
    });
}

function scheduleHistoryRefresh(
  host: VoiceHost,
  refreshState: HistoryRefreshState,
  immediate = false,
): void {
  if (refreshState.disposed) {
    return;
  }
  debugVoice("voice history refresh", {
    sessionKey: host.voiceSessionKey ?? host.sessionKey,
    state: immediate ? "queued-immediate" : "scheduled",
  });
  if (refreshState.timer !== null) {
    window.clearTimeout(refreshState.timer);
  }
  refreshState.timer = window.setTimeout(() => {
    refreshState.timer = null;
    runHistoryRefresh(host, refreshState);
  }, immediate ? 0 : 180);
}

const transcriptBuffers = new WeakMap<VoiceHost, TranscriptBufferState>();

function appendTranscriptBuffer(buffer: string, incoming: string): string {
  if (!buffer) {
    return incoming;
  }
  if (incoming.startsWith(buffer)) {
    return incoming;
  }
  return `${buffer}${incoming}`;
}

function buildLiveTurn(text: string, final: boolean, startedAt: number, updatedAt: number): VoiceLiveTurn {
  return {
    text,
    final,
    startedAt,
    updatedAt,
  };
}

function applyTranscriptUpdate(
  host: VoiceHost,
  params: { role: "user" | "assistant"; text: string; final: boolean },
): void {
  const state = transcriptBuffers.get(host) ?? {
    user: "",
    assistant: "",
    userStartedAt: null,
    assistantStartedAt: null,
  };
  const now = Date.now();

  debugVoice("voice transcript update received", {
    role: params.role,
    final: params.final,
    textLength: params.text.length,
    sessionKey: host.voiceSessionKey ?? host.sessionKey,
  });
  debugVoicePayload("voice transcript update payload", params, {
    sessionKey: host.voiceSessionKey ?? host.sessionKey,
  });

  if (params.role === "user") {
    if (params.final) {
      const startedAt =
        state.userStartedAt ??
        (host.voiceLiveUserTurn && !host.voiceLiveUserTurn.final
          ? host.voiceLiveUserTurn.startedAt
          : now);
      state.user = "";
      state.userStartedAt = null;
      host.voiceLiveUserTurn = buildLiveTurn(params.text, true, startedAt, now);
      transcriptBuffers.set(host, state);
      maybeClearSettledVoiceTurns(host);
      debugVoice("voice transcript update applied", { role: params.role, final: params.final, userTextLength: host.voiceLiveUserTurn?.text.length ?? 0, assistantTextLength: host.voiceLiveAssistantTurn?.text.length ?? 0 });
      notifyVoiceHostUpdated(host);
      return;
    }
    if (state.userStartedAt === null || host.voiceLiveUserTurn?.final) {
      state.userStartedAt = now;
    }
    state.user = appendTranscriptBuffer(state.user, params.text);
    if (host.voiceLiveAssistantTurn && !host.voiceLiveAssistantTurn.final) {
      host.voiceLiveAssistantTurn = null;
      state.assistant = "";
      state.assistantStartedAt = null;
    }
    host.voiceLiveUserTurn = buildLiveTurn(state.user, false, state.userStartedAt ?? now, now);
    transcriptBuffers.set(host, state);
    debugVoice("voice transcript update applied", { role: params.role, final: params.final, userTextLength: host.voiceLiveUserTurn?.text.length ?? 0, assistantTextLength: host.voiceLiveAssistantTurn?.text.length ?? 0 });
    notifyVoiceHostUpdated(host);
    return;
  }

  if (params.final) {
    const startedAt =
      state.assistantStartedAt ??
      (host.voiceLiveAssistantTurn && !host.voiceLiveAssistantTurn.final
        ? host.voiceLiveAssistantTurn.startedAt
        : now);
    state.assistant = "";
    state.assistantStartedAt = null;
    host.voiceLiveAssistantTurn = buildLiveTurn(params.text, true, startedAt, now);
    transcriptBuffers.set(host, state);
    maybeClearSettledVoiceTurns(host);
    debugVoice("voice transcript update applied", { role: params.role, final: params.final, userTextLength: host.voiceLiveUserTurn?.text.length ?? 0, assistantTextLength: host.voiceLiveAssistantTurn?.text.length ?? 0 });
    notifyVoiceHostUpdated(host);
    return;
  }

  if (state.assistantStartedAt === null || host.voiceLiveAssistantTurn?.final) {
    state.assistantStartedAt = now;
  }
  state.assistant = appendTranscriptBuffer(state.assistant, params.text);
  host.voiceLiveAssistantTurn = buildLiveTurn(
    state.assistant,
    false,
    state.assistantStartedAt ?? now,
    now,
  );
  transcriptBuffers.set(host, state);
  debugVoice("voice transcript update applied", { role: params.role, final: params.final, userTextLength: host.voiceLiveUserTurn?.text.length ?? 0, assistantTextLength: host.voiceLiveAssistantTurn?.text.length ?? 0 });
  notifyVoiceHostUpdated(host);
}


function resetVoiceState(host: VoiceHost, preserveError = false): void {
  host.voiceHandle = null;
  host.voiceConnecting = false;
  host.voiceConnected = false;
  host.voiceStatus = null;
  host.voiceSessionKey = null;
  host.voiceProvider = null;
  host.voiceLiveUserTurn = null;
  host.voiceLiveAssistantTurn = null;
  host.voiceVolume = 0;
  transcriptBuffers.delete(host);
  if (!preserveError) {
    host.voiceError = null;
  }
  notifyVoiceHostUpdated(host);
}

export async function handleVoiceConnect(host: VoiceHost): Promise<void> {
  if (host.voiceConnecting || host.voiceConnected) {
    return;
  }

  host.voiceSupported = resolveVoiceSupport();
  debugVoice("voice preflight", {
    supported: host.voiceSupported,
    connected: host.connected,
    hasClient: Boolean(host.client),
    configLoading: host.voiceConfigLoading,
    available: host.voiceAvailable,
    availabilityReason: host.voiceAvailabilityReason,
    deprecationCount: host.voiceDeprecations.length,
  });
  if (!host.voiceSupported) {
    host.voiceError = "Browser voice requires microphone access, Web Audio, and AudioWorklet support.";
    debugVoice("voice preflight", { supported: false, reason: host.voiceError });
    return;
  }
  if (!host.connected || !host.client) {
    host.voiceError = "Connect to the gateway before starting voice.";
    debugVoice("voice preflight", { supported: true, reason: host.voiceError });
    return;
  }
  if (host.voiceConfigLoading) {
    host.voiceError = "Checking browser voice configuration. Retry in a moment.";
    debugVoice("voice preflight", { supported: true, reason: host.voiceError });
    return;
  }
  if (!host.voiceAvailable) {
    host.voiceError =
      host.voiceAvailabilityReason ?? "Browser voice is unavailable in the current gateway config.";
    debugVoice("voice preflight", { supported: true, available: false, reason: host.voiceError });
    return;
  }

  host.voiceConnecting = true;
  host.voiceError = null;
  host.voiceStatus = "Preparing voice session";
  host.voiceLiveUserTurn = null;
  host.voiceLiveAssistantTurn = null;
  host.voiceVolume = 0;

  let capture: AudioCapture | null = null;
  let playback: AudioPlayback | null = null;
  let ws: WebSocket | null = null;
  let streamAudioEnabled = false;
  let closing = false;
  let lastVolumeDebugAt = 0;
  let lastAudioMetricsDebugAt = 0;
  let sawMeaningfulVolume = false;
  let quietCaptureFrames = 0;
  let totalCaptureFrames = 0;
  let captureSilenceWarningEmitted = false;
  let transcriptReceived = false;
  let transcriptWarningTimer: number | null = null;
  const refreshState: HistoryRefreshState = {
    timer: null,
    inFlight: false,
    pending: false,
    disposed: false,
  };
  const pendingFrameStats: Array<Pcm16AudioMetrics & { sequence: number }> = [];
  let outboundAudioFrames = 0;

  const clearTranscriptWarning = () => {
    if (transcriptWarningTimer !== null) {
      window.clearTimeout(transcriptWarningTimer);
      transcriptWarningTimer = null;
    }
  };

  const scheduleTranscriptWarning = () => {
    clearTranscriptWarning();
    transcriptWarningTimer = window.setTimeout(() => {
      transcriptWarningTimer = null;
      if (closing || transcriptReceived || outboundAudioFrames < 1 || !streamAudioEnabled) {
        return;
      }
      debugVoice("voice transcript warning", {
        sessionKey: host.voiceSessionKey ?? host.sessionKey,
        providerId: host.voiceProvider,
        audioFrameCount: outboundAudioFrames,
        reason: "no-transcript-after-audio",
      });
    }, VOICE_NO_TRANSCRIPT_WARNING_MS);
  };

  const maybeLogCaptureSilenceWarning = () => {
    if (captureSilenceWarningEmitted) {
      return;
    }
    if (!sawMeaningfulVolume || totalCaptureFrames < VOICE_AUDIO_SILENCE_WARNING_FRAME_COUNT) {
      return;
    }
    if (quietCaptureFrames / totalCaptureFrames < 0.9) {
      return;
    }
    captureSilenceWarningEmitted = true;
    debugVoice("voice capture warning", {
      sessionKey: host.voiceSessionKey ?? host.sessionKey,
      providerId: host.voiceProvider,
      reason: "near-silence-after-mic-activity",
      frameCount: totalCaptureFrames,
      quietFrameRatio: roundVoiceAudioMetric(quietCaptureFrames / totalCaptureFrames),
    });
  };

  const teardown = async (params?: { preserveError?: boolean; skipSocketClose?: boolean }) => {
    if (closing) {
      return;
    }
    closing = true;
    streamAudioEnabled = false;
    refreshState.disposed = true;

    resetVoiceState(host, params?.preserveError === true);

    if (refreshState.timer !== null) {
      window.clearTimeout(refreshState.timer);
      refreshState.timer = null;
    }
    clearTranscriptWarning();

    if (capture) {
      await capture.stop();
      debugVoice("voice capture", {
        sessionKey: host.voiceSessionKey ?? host.sessionKey,
        state: "stopped",
      });
    }

    if (playback) {
      playback.stop();
      debugVoice("voice playback event", {
        sessionKey: host.voiceSessionKey ?? host.sessionKey,
        state: "stopped",
      });
    }

    if (ws && !params?.skipSocketClose) {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        try {
          ws.close(1000, "voice stop");
        } catch {}
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
    debugVoice("voice microphone permission", {
      sessionKey: bootstrapSessionKey,
      providerId,
      state: "request",
    });

    capture = new AudioCapture({
      sampleRateHz,
      frameDurationMs,
      onAudioData: (data) => {
        const frameStats = pendingFrameStats.shift();
        if (streamAudioEnabled && ws && ws.readyState === WebSocket.OPEN) {
          outboundAudioFrames += 1;
          if (frameStats) {
            debugVoice("voice capture audio frame", {
              sessionKey: host.voiceSessionKey ?? bootstrapSessionKey,
              providerId: host.voiceProvider ?? providerId,
              audioSequence: outboundAudioFrames,
              sampleCount: frameStats.sampleCount,
              byteLength: frameStats.byteLength,
              rms: roundVoiceAudioMetric(frameStats.rms),
              peak: roundVoiceAudioMetric(frameStats.peak),
              nonZeroRatio: roundVoiceAudioMetric(frameStats.nonZeroRatio),
              clippedRatio: roundVoiceAudioMetric(frameStats.clippedRatio),
              durationMs: roundVoiceAudioMetric(frameStats.durationMs),
            });
          }
          ws.send(data);
        }
      },
      onVolumeChange: (volume) => {
        host.voiceVolume = volume;
        if (volume >= VOICE_AUDIO_ACTIVITY_VOLUME_THRESHOLD) {
          sawMeaningfulVolume = true;
        }
        const now = Date.now();
        if (now - lastVolumeDebugAt >= 250) {
          lastVolumeDebugAt = now;
          debugVoice("voice capture", {
            sessionKey: host.voiceSessionKey ?? bootstrapSessionKey,
            providerId: host.voiceProvider ?? providerId,
            state: "volume",
            volume,
          });
        }
      },
      onAudioFrameStats: (stats) => {
        pendingFrameStats.push(stats);
        totalCaptureFrames += 1;
        if (
          stats.rms < VOICE_AUDIO_SILENCE_RMS_THRESHOLD ||
          stats.nonZeroRatio < 0.1
        ) {
          quietCaptureFrames += 1;
        }
        const now = Date.now();
        if (
          stats.sequence === 1 ||
          now - lastAudioMetricsDebugAt >= VOICE_AUDIO_DEBUG_LOG_INTERVAL_MS
        ) {
          lastAudioMetricsDebugAt = now;
          debugVoice("voice capture stats", {
            sessionKey: host.voiceSessionKey ?? bootstrapSessionKey,
            providerId: host.voiceProvider ?? providerId,
            audioSequence: stats.sequence,
            sampleCount: stats.sampleCount,
            byteLength: stats.byteLength,
            rms: roundVoiceAudioMetric(stats.rms),
            peak: roundVoiceAudioMetric(stats.peak),
            nonZeroRatio: roundVoiceAudioMetric(stats.nonZeroRatio),
            clippedRatio: roundVoiceAudioMetric(stats.clippedRatio),
            durationMs: roundVoiceAudioMetric(stats.durationMs),
          });
        }
        maybeLogCaptureSilenceWarning();
      },
    });
    await capture.start();
    debugVoice("voice microphone permission", {
      sessionKey: bootstrapSessionKey,
      providerId,
      state: "granted",
    });
    debugVoice("voice capture", {
      sessionKey: bootstrapSessionKey,
      providerId,
      state: "started",
      sampleRateHz,
      frameDurationMs,
    });
    debugVoice("voice capture summary", {
      sessionKey: bootstrapSessionKey,
      providerId,
      sampleRateHz,
      frameDurationMs,
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    });

    ws = new WebSocket(buildVoiceWebSocketUrl(host.settings.gatewayUrl, wsPath));
    ws.binaryType = "arraybuffer";
    debugVoice("voice websocket connecting", {
      sessionKey: bootstrapSessionKey,
      providerId,
      wsPath,
      sampleRateHz,
      frameDurationMs,
    });

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
          debugVoice("voice playback event", {
            sessionKey: host.voiceSessionKey ?? bootstrapSessionKey,
            providerId: host.voiceProvider ?? providerId,
            state: "interrupt",
          });
        }
        const payload = { type: "interrupt" };
        debugVoice("voice websocket send", {
          sessionKey: host.voiceSessionKey ?? bootstrapSessionKey,
          providerId: host.voiceProvider ?? providerId,
          frameType: "interrupt",
        });
        debugVoicePayload("voice websocket send payload", payload, {
          sessionKey: host.voiceSessionKey ?? bootstrapSessionKey,
          providerId: host.voiceProvider ?? providerId,
          frameType: "interrupt",
        });
        ws.send(JSON.stringify(payload));
      },
    };
    host.voiceHandle = voiceHandle;

    ws.addEventListener("open", () => {
      host.voiceStatus = "Starting voice session";
      debugVoice("voice websocket open", { sessionKey: bootstrapSessionKey, providerId });
      const payload = { type: "start", ticket };
      debugVoice("voice websocket send", {
        sessionKey: bootstrapSessionKey,
        providerId,
        frameType: "start",
      });
      debugVoicePayload("voice websocket send payload", payload, {
        sessionKey: bootstrapSessionKey,
        providerId,
        frameType: "start",
      });
      ws?.send(JSON.stringify(payload));
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
        debugVoice("voice websocket receive", {
          sessionKey: host.voiceSessionKey ?? bootstrapSessionKey,
          providerId: host.voiceProvider ?? providerId,
          frameType: parsed.type,
        });
        debugVoicePayload("voice websocket receive payload", parsed, {
          sessionKey: host.voiceSessionKey ?? bootstrapSessionKey,
          providerId: host.voiceProvider ?? providerId,
          frameType: parsed.type,
        });
        switch (parsed.type) {
          case "ready": {
            const readySampleRateHz =
              typeof parsed.transport?.sampleRateHz === "number"
                ? parsed.transport.sampleRateHz
                : sampleRateHz;
            host.voiceConnecting = false;
            host.voiceConnected = true;
            host.voiceProvider = normalizeString(parsed.provider) ?? providerId;
            host.voiceSessionKey = normalizeString(parsed.sessionKey) ?? bootstrapSessionKey;
            host.voiceStatus = "Listening";
            streamAudioEnabled = true;
            if (playback) {
              playback.stop();
            }
            playback = new AudioPlayback(readySampleRateHz);
            playback.start();
            scheduleTranscriptWarning();
            debugVoice("voice control frame", {
              frameType: "ready",
              sessionKey: host.voiceSessionKey,
              providerId: host.voiceProvider,
              sampleRateHz: readySampleRateHz,
            });
            debugVoice("voice playback event", {
              sessionKey: host.voiceSessionKey ?? bootstrapSessionKey,
              providerId: host.voiceProvider ?? providerId,
              state: "started",
              sampleRateHz: readySampleRateHz,
            });
            return;
          }
          case "state": {
            const nextState = normalizeString(parsed.state);
            const detail = normalizeString(parsed.detail);
            host.voiceStatus = formatVoiceStatus(nextState, detail);
            debugVoice("voice control frame", {
              frameType: "state",
              sessionKey: host.voiceSessionKey ?? bootstrapSessionKey,
              providerId: host.voiceProvider ?? providerId,
              state: nextState,
              detail,
            });
            if (nextState === "listening" && playback) {
              playback.interrupt();
            }
            return;
          }
          case "transcript": {
            const role = normalizeString(parsed.role);
            const final = parsed.final === true;
            const text = normalizeTranscriptText(parsed.text, final);
            if ((role !== "user" && role !== "assistant") || !text) {
              return;
            }
            transcriptReceived = true;
            clearTranscriptWarning();
            debugVoice("voice control frame", {
              frameType: "transcript",
              sessionKey: host.voiceSessionKey ?? bootstrapSessionKey,
              providerId: host.voiceProvider ?? providerId,
              role,
              final,
              textLength: text.length,
            });
            applyTranscriptUpdate(host, { role, text, final });
            if (final) {
              scheduleHistoryRefresh(host, refreshState);
            }
            return;
          }
          case "tool_call": {
            const name = normalizeString(parsed.name);
            host.voiceStatus = name ? `Tool: ${name}` : "Tool running";
            debugVoice("voice control frame", {
              frameType: "tool_call",
              sessionKey: host.voiceSessionKey ?? bootstrapSessionKey,
              providerId: host.voiceProvider ?? providerId,
              name,
            });
            return;
          }
          case "tool_result": {
            const name = normalizeString(parsed.name);
            host.voiceStatus = name ? `Tool complete: ${name}` : "Tool complete";
            debugVoice("voice control frame", {
              frameType: "tool_result",
              sessionKey: host.voiceSessionKey ?? bootstrapSessionKey,
              providerId: host.voiceProvider ?? providerId,
              name,
            });
            scheduleHistoryRefresh(host, refreshState);
            return;
          }
          case "error": {
            host.voiceError = normalizeString(parsed.message) ?? "Voice session error";
            debugVoice("voice control frame", {
              frameType: "error",
              sessionKey: host.voiceSessionKey ?? bootstrapSessionKey,
              providerId: host.voiceProvider ?? providerId,
              hasMessage: Boolean(host.voiceError),
            });
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
        debugVoice("voice websocket receive", {
          sessionKey: host.voiceSessionKey ?? bootstrapSessionKey,
          providerId: host.voiceProvider ?? providerId,
          frameType: "audio",
          byteLength: event.data.byteLength,
        });
        playback.enqueue(event.data);
        debugVoice("voice playback event", {
          sessionKey: host.voiceSessionKey ?? bootstrapSessionKey,
          providerId: host.voiceProvider ?? providerId,
          state: "enqueue",
          byteLength: event.data.byteLength,
        });
        return;
      }
      if (event.data instanceof Blob) {
        const blobSize = typeof event.data.size === "number" ? event.data.size : undefined;
        debugVoice("voice websocket receive", {
          sessionKey: host.voiceSessionKey ?? bootstrapSessionKey,
          providerId: host.voiceProvider ?? providerId,
          frameType: "audio-blob",
          byteLength: blobSize,
        });
        void event.data.arrayBuffer().then((payload) => {
          debugVoice("voice playback event", {
            sessionKey: host.voiceSessionKey ?? bootstrapSessionKey,
            providerId: host.voiceProvider ?? providerId,
            state: "enqueue",
            byteLength: payload.byteLength,
          });
          playback!.enqueue(payload);
        });
      }
    });

    ws.addEventListener("close", (event) => {
      debugVoice("voice websocket closed", {
        sessionKey: host.voiceSessionKey ?? bootstrapSessionKey,
        providerId: host.voiceProvider ?? providerId,
        code: event.code,
        reason: event.reason || undefined,
      });
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
      debugVoice("voice websocket error", {
        sessionKey: host.voiceSessionKey ?? bootstrapSessionKey,
        providerId: host.voiceProvider ?? providerId,
      });
    });
  } catch (error) {
    await teardown({ preserveError: true, skipSocketClose: true });
    const message = error instanceof Error ? error.message : String(error);
    host.voiceError = message;
    host.voiceStatus = null;
    debugVoice("voice microphone permission", {
      sessionKey: host.voiceSessionKey ?? host.sessionKey,
      providerId: host.voiceProvider,
      state: "error",
      error: message,
    });
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


