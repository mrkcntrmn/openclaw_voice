import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import WebSocket from "ws";
import {
  resolveAgentDir,
  resolveAgentWorkspaceDir,
  resolveDefaultAgentId,
} from "../agents/agent-scope.js";
import { convertTools } from "../agents/openai-ws-stream.js";
import { toToolDefinitions } from "../agents/pi-tool-definition-adapter.js";
import { createOpenClawCodingTools } from "../agents/pi-tools.js";
import { cleanToolSchemaForGemini } from "../agents/pi-tools.schema.js";
import { loadConfig, type OpenClawConfig } from "../config/config.js";
import { isTruthyEnvValue } from "../infra/env.js";
import {
  createVoiceDebugLogger,
  summarizeVoiceDebugPayload,
  voiceDebugElapsedMs,
} from "./debug.js";
import {
  measurePcm16AudioBuffer,
  roundVoiceAudioMetric,
} from "./audio-debug.js";
import {
  defaultVoiceSampleRateHzForProvider,
  DEFAULT_VOICE_FRAME_DURATION_MS,
  DEFAULT_VOICE_PROVIDER,
  DEFAULT_VOICE_SESSION_KEY_PREFIX,
  normalizeVoiceSection,
  resolveActiveVoiceProviderConfig,
} from "../config/voice.js";
import type { VoiceConfig, VoiceProviderConfig } from "../config/types.gateway.js";
import { resolveConfiguredSecretInputWithFallback } from "../gateway/resolve-configured-secret-input-string.js";
import {
  appendVoiceTranscriptMessage,
  loadVoiceConversationHistory,
  type VoiceHistoryTurn,
} from "./transcript.js";

const DEFAULT_OPENAI_REALTIME_MODEL = "gpt-4o-realtime-preview";
const DEFAULT_GEMINI_LIVE_MODEL = "gemini-2.0-flash-exp";
const DEFAULT_OPENAI_TRANSCRIPTION_MODEL = "gpt-4o-mini-transcribe";
const DEBUG_OPENAI_FORCE_COMMIT_IDLE_MS = 1_500;
const DEBUG_OPENAI_FORCE_COMMIT_QUIET_FRAME_COUNT = 60;
const DEBUG_OPENAI_FORCE_COMMIT_RMS_THRESHOLD = 0.01;
const DEBUG_OPENAI_FORCE_COMMIT_PEAK_THRESHOLD = 0.03;
const DEFAULT_GATEWAY_VOICE_INSTRUCTIONS =
  "You are OpenClaw's realtime voice assistant. Keep replies concise, conversational, and tool-aware. Use tools when they materially help, and avoid narrating internal implementation details unless asked.";
const voiceDebug = createVoiceDebugLogger("voice");

function debugVoice(message: string, meta?: Record<string, unknown>): void {
  voiceDebug.debug(message, meta);
}

function debugVoicePayload(message: string, payload: unknown, meta?: Record<string, unknown>): void {
  voiceDebug.payload(message, payload, meta);
}

function isOpenAIRealtimeDebugForceCommitEnabled(): boolean {
  return isTruthyEnvValue(process.env.OPENCLAW_DEBUG_VOICE_FORCE_COMMIT);
}


export type VoiceTranscriptEvent = {
  role: "user" | "assistant";
  text: string;
  final: boolean;
};

export type VoiceToolCallEvent = {
  callId: string;
  name: string;
  arguments: Record<string, unknown>;
};

export type VoiceToolResultEvent = VoiceToolCallEvent & {
  output: string;
};

export type VoiceStateEvent = {
  state: "connecting" | "connected" | "listening" | "responding" | "tool" | "closed";
  detail?: string;
};

export type VoiceErrorEvent = {
  message: string;
  cause?: unknown;
};

export type VoiceAdapterConnectOptions = {
  provider: VoiceProviderConfig;
  providerId: string;
  modelId: string;
  sampleRateHz: number;
  instructions: string;
  tools: ToolDefinition[];
  history: VoiceHistoryTurn[];
};

export type VoiceTransportConfig = {
  inputSampleRateHz?: number;
  outputSampleRateHz?: number;
  sampleRateHz?: number;
};

export type ResolvedVoiceSessionConfig = {
  cfg: OpenClawConfig;
  voice: VoiceConfig;
  providerId: string;
  provider: VoiceProviderConfig & { apiKey?: string };
  modelId: string;
  browser: {
    enabled: boolean;
    wsPath: string;
    sampleRateHz: number;
    channels: number;
    frameDurationMs: number;
    vad: "client" | "provider" | "server";
    authTimeoutMs: number;
  };
  session: {
    interruptOnSpeech: boolean;
    pauseOnToolCall: boolean;
    persistTranscripts: boolean;
    sharedChatHistory: boolean;
    transcriptSource: "provider";
    silenceTimeoutMs?: number;
    sessionKeyPrefix: string;
  };
  deployment: {
    websocket: {
      maxSessionMinutes?: number;
    };
  };
};

export type VoiceSessionRuntime = {
  resolved: ResolvedVoiceSessionConfig;
  history: VoiceHistoryTurn[];
  toolRuntime: VoiceToolRuntime;
  adapter: VoiceAdapter;
  orchestrator: VoiceSessionOrchestrator;
  connect: () => Promise<void>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeTranscriptDelta(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  return value.length > 0 ? value : undefined;
}

function normalizePositiveInteger(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    return undefined;
  }
  return value;
}

function stringifyToolOutput(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function collectToolText(result: unknown): string {
  if (!result || typeof result !== "object") {
    return stringifyToolOutput(result);
  }
  const content = (result as { content?: unknown }).content;
  if (Array.isArray(content)) {
    const text = content
      .map((entry) => {
        if (!entry || typeof entry !== "object") {
          return null;
        }
        const typed = entry as { type?: unknown; text?: unknown };
        return typed.type === "text" && typeof typed.text === "string" ? typed.text : null;
      })
      .filter((entry): entry is string => Boolean(entry))
      .join("\n")
      .trim();
    if (text) {
      return text;
    }
  }
  return stringifyToolOutput((result as { details?: unknown }).details ?? result);
}

function executeToolDefinition(
  tool: ToolDefinition,
  toolCallId: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  const execute = tool.execute.bind(tool) as unknown as (
    nextToolCallId: string,
    nextParams: Record<string, unknown>,
    signal?: AbortSignal,
    onUpdate?: unknown,
    context?: unknown,
  ) => Promise<unknown>;
  return execute(toolCallId, params, undefined, undefined, undefined);
}

function toGeminiTools(tools: ToolDefinition[]) {
  if (tools.length === 0) {
    return undefined;
  }
  return [
    {
      functionDeclarations: tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters
          ? (cleanToolSchemaForGemini(tool.parameters as Record<string, unknown>) as Record<
              string,
              unknown
            >)
          : { type: "object", properties: {} },
      })),
    },
  ];
}

function toOpenAIRealtimeTools(tools: ToolDefinition[]) {
  if (tools.length === 0) {
    return undefined;
  }
  return tools.map((tool) => ({
    type: "function" as const,
    name: tool.name,
    description: typeof tool.description === "string" ? tool.description : "",
    parameters: (tool.parameters ?? {}) as Record<string, unknown>,
  }));
}

type VoiceToolRuntime = {
  definitions: ToolDefinition[];
  execute: (call: VoiceToolCallEvent) => Promise<VoiceToolResultEvent>;
};

export function createVoiceToolRuntime(params: {
  cfg?: OpenClawConfig;
  sessionKey: string;
  sessionId?: string;
  agentId?: string;
  modelProvider?: string;
  modelId?: string;
}): VoiceToolRuntime {
  const cfg = params.cfg ?? loadConfig();
  const agentId = params.agentId ?? resolveDefaultAgentId(cfg);
  const rawTools = createOpenClawCodingTools({
    config: cfg,
    agentId,
    agentDir: resolveAgentDir(cfg, agentId),
    workspaceDir: resolveAgentWorkspaceDir(cfg, agentId),
    sessionKey: params.sessionKey,
    sessionId: params.sessionId,
    messageProvider: "voice",
    modelProvider: params.modelProvider,
    modelId: params.modelId,
    senderIsOwner: true,
  });
  const definitions = toToolDefinitions(rawTools);
  return {
    definitions,
    execute: async (call) => {
      const definition = definitions.find((candidate) => candidate.name === call.name);
      if (!definition) {
        return {
          ...call,
          output: JSON.stringify({ status: "error", error: `Unknown tool: ${call.name}` }),
        };
      }
      const result = await executeToolDefinition(definition, call.callId, call.arguments);
      return {
        ...call,
        output: collectToolText(result),
      };
    },
  };
}

export abstract class VoiceAdapter extends EventEmitter {
  abstract connect(options: VoiceAdapterConnectOptions): Promise<void>;
  abstract sendAudio(audio: Buffer): void;
  abstract sendText(text: string): void;
  abstract sendToolResult(callId: string, output: string, name?: string): void;
  abstract interrupt(): void;
  abstract close(): void;

  getTransportConfig(): VoiceTransportConfig | null {
    return null;
  }
}

function buildVoiceInstructions(params: {
  history: VoiceHistoryTurn[];
  instructions: string;
}): string {
  if (params.history.length === 0) {
    return params.instructions;
  }
  const historyText = params.history
    .map((turn) => `${turn.role === "assistant" ? "Assistant" : "User"}: ${turn.text}`)
    .join("\n");
  return `${params.instructions}\n\nRecent conversation:\n${historyText}`;
}

function createWebSocket(url: string, headers: Record<string, string>): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers });
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
  });
}

function parseJsonObject(raw: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function parseToolArguments(value: unknown): Record<string, unknown> {
  if (isRecord(value)) {
    return value;
  }
  if (typeof value !== "string") {
    return {};
  }
  const parsed = parseJsonObject(value);
  return parsed ?? {};
}

function voiceApiKeyFallback(providerId: string): string | undefined {
  const normalized = providerId.trim().toLowerCase();
  if (normalized.includes("openai")) {
    return process.env.OPENAI_API_KEY?.trim() || undefined;
  }
  if (normalized.includes("gemini") || normalized.includes("google")) {
    return process.env.GEMINI_API_KEY?.trim() || process.env.GOOGLE_API_KEY?.trim() || undefined;
  }
  return undefined;
}

function defaultModelIdForProvider(providerId: string): string {
  const normalized = providerId.trim().toLowerCase();
  if (normalized.includes("gemini") || normalized.includes("google")) {
    return DEFAULT_GEMINI_LIVE_MODEL;
  }
  return DEFAULT_OPENAI_REALTIME_MODEL;
}

function defaultTranscriptionModelIdForProvider(providerId: string): string | undefined {
  const normalized = providerId.trim().toLowerCase();
  if (normalized.includes("openai")) {
    return DEFAULT_OPENAI_TRANSCRIPTION_MODEL;
  }
  return undefined;
}

function resolveRealtimeAudioSection(
  session: Record<string, unknown> | null,
  direction: "input" | "output",
): Record<string, unknown> | null {
  const audio = isRecord(session?.audio) ? session.audio : null;
  return isRecord(audio?.[direction]) ? audio[direction] : null;
}

function resolveRealtimeAudioFormat(
  session: Record<string, unknown> | null,
  direction: "input" | "output",
): { type?: string; sampleRateHz?: number } | null {
  const section = resolveRealtimeAudioSection(session, direction);
  const format = isRecord(section?.format) ? section.format : null;
  if (format) {
    return {
      type: normalizeNonEmptyString(format.type),
      sampleRateHz:
        normalizePositiveInteger(format.rate) ??
        normalizePositiveInteger(format.sample_rate) ??
        normalizePositiveInteger(format.sampleRateHz),
    };
  }

  const legacyKey = direction === "input" ? "input_audio_format" : "output_audio_format";
  const legacyFormat = normalizeNonEmptyString(session?.[legacyKey]);
  if (!legacyFormat) {
    return null;
  }
  return {
    type: legacyFormat,
  };
}

function buildDefaultSessionKey(prefix: string, hint = "browser"): string {
  return `${prefix}:${hint}:${randomUUID()}`;
}

function validateBrowserVoiceMvpConfig(resolved: {
  browser: ResolvedVoiceSessionConfig["browser"];
  session: ResolvedVoiceSessionConfig["session"];
}): void {
  if (resolved.browser.channels !== 1) {
    throw new Error("voice.browser.channels must be 1 for browser voice");
  }
  if (resolved.browser.vad !== "provider") {
    throw new Error('voice.browser.vad must be "provider" for browser voice');
  }
  if (!resolved.session.sharedChatHistory) {
    throw new Error("voice.session.sharedChatHistory must be true for browser voice");
  }
}

export async function resolveVoiceSessionConfig(params: {
  cfg?: OpenClawConfig;
  voice?: VoiceConfig;
  providerId?: string;
}): Promise<ResolvedVoiceSessionConfig> {
  const cfg = params.cfg ?? loadConfig();
  const voice = normalizeVoiceSection(params.voice ?? cfg.voice);
  if (!voice) {
    throw new Error("voice config is not configured");
  }

  const requestedProviderId = normalizeNonEmptyString(params.providerId);
  const active = resolveActiveVoiceProviderConfig(
    requestedProviderId ? { ...voice, provider: requestedProviderId } : voice,
  );
  const providerId =
    requestedProviderId ??
    active?.provider ??
    normalizeNonEmptyString(voice.provider) ??
    Object.keys(voice.providers ?? {})[0] ??
    DEFAULT_VOICE_PROVIDER;
  const provider = {
    ...(voice.providers?.[providerId] ?? active?.config),
  } as VoiceProviderConfig & { apiKey?: string };

  const resolvedApiKey = await resolveConfiguredSecretInputWithFallback({
    config: cfg,
    env: process.env,
    value: provider.apiKey,
    path: `voice.providers.${providerId}.apiKey`,
    unresolvedReasonStyle: "detailed",
    readFallback: () => voiceApiKeyFallback(providerId),
  });
  if (resolvedApiKey.unresolvedRefReason) {
    throw new Error(resolvedApiKey.unresolvedRefReason);
  }
  if (resolvedApiKey.value) {
    provider.apiKey = resolvedApiKey.value;
  }

  const modelId = normalizeNonEmptyString(provider.modelId) ?? defaultModelIdForProvider(providerId);
  const wsPathRaw = normalizeNonEmptyString(voice.browser?.wsPath) ?? "/voice/ws";
  const wsPath = wsPathRaw.startsWith("/") ? wsPathRaw : `/${wsPathRaw}`;

  const resolved = {
    cfg,
    voice,
    providerId,
    provider,
    modelId,
    browser: {
      enabled: voice.browser?.enabled !== false,
      wsPath,
      sampleRateHz:
        voice.browser?.sampleRateHz ?? defaultVoiceSampleRateHzForProvider(providerId),
      channels: voice.browser?.channels ?? 1,
      frameDurationMs: voice.browser?.frameDurationMs ?? DEFAULT_VOICE_FRAME_DURATION_MS,
      vad: voice.browser?.vad ?? "provider",
      authTimeoutMs: voice.browser?.authTimeoutMs ?? 10_000,
    },
    session: {
      interruptOnSpeech: voice.session?.interruptOnSpeech !== false,
      pauseOnToolCall: voice.session?.pauseOnToolCall !== false,
      persistTranscripts: voice.session?.persistTranscripts !== false,
      sharedChatHistory: voice.session?.sharedChatHistory !== false,
      transcriptSource: "provider",
      silenceTimeoutMs: voice.session?.silenceTimeoutMs,
      sessionKeyPrefix: voice.session?.sessionKeyPrefix ?? DEFAULT_VOICE_SESSION_KEY_PREFIX,
    },
    deployment: {
      websocket: {
        maxSessionMinutes: voice.deployment?.websocket?.maxSessionMinutes,
      },
    },
  } satisfies ResolvedVoiceSessionConfig;

  validateBrowserVoiceMvpConfig(resolved);
  return resolved;
}

export function createVoiceAdapter(providerId: string): VoiceAdapter {
  const normalized = providerId.trim().toLowerCase();
  if (normalized.includes("gemini") || normalized.includes("google")) {
    return new GeminiLiveVoiceAdapter();
  }
  return new OpenAIRealtimeVoiceAdapter();
}
class OpenAIRealtimeVoiceAdapter extends VoiceAdapter {
  private ws: WebSocket | null = null;
  private toolArgumentBuffer = new Map<string, { name: string; argumentsText: string }>();
  private emittedToolCalls = new Set<string>();
  private audioFramesSent = 0;
  private firstAudioSentAt: number | null = null;
  private firstProviderEventAt: number | null = null;
  private firstSpeechAt: number | null = null;
  private firstSpeechStoppedAt: number | null = null;
  private firstTranscriptAt: number | null = null;
  private firstAudioResponseAt: number | null = null;
  private firstResponseCreatedAt: number | null = null;
  private providerEventCount = 0;
  private noSpeechWarningEmitted = false;
  private noTranscriptWarningEmitted = false;
  private noResponseWarningEmitted = false;
  private bootstrapOnlyWarningEmitted = false;
  private providerId = "openai-realtime";
  private modelId = DEFAULT_OPENAI_REALTIME_MODEL;
  private inputSampleRateHz = defaultVoiceSampleRateHzForProvider("openai-realtime");
  private outputSampleRateHz = defaultVoiceSampleRateHzForProvider("openai-realtime");
  private speechActive = false;
  private currentTurnResponseCreated = false;
  private currentTurnQuietFrames = 0;
  private currentTurnFallbackIssued = false;
  private forceCommitTimer: ReturnType<typeof setTimeout> | null = null;

  async connect(options: VoiceAdapterConnectOptions): Promise<void> {
    const apiKey = normalizeNonEmptyString(options.provider.apiKey);
    if (!apiKey) {
      throw new Error(`voice.providers.${options.providerId}.apiKey is required for OpenAI realtime`);
    }

    this.providerId = options.providerId;
    this.modelId = options.modelId;
    this.inputSampleRateHz = options.sampleRateHz;
    this.outputSampleRateHz = options.sampleRateHz;
    this.audioFramesSent = 0;
    this.firstAudioSentAt = null;
    this.firstProviderEventAt = null;
    this.firstSpeechAt = null;
    this.firstSpeechStoppedAt = null;
    this.firstTranscriptAt = null;
    this.firstAudioResponseAt = null;
    this.firstResponseCreatedAt = null;
    this.providerEventCount = 0;
    this.noSpeechWarningEmitted = false;
    this.noTranscriptWarningEmitted = false;
    this.noResponseWarningEmitted = false;
    this.bootstrapOnlyWarningEmitted = false;
    this.speechActive = false;
    this.currentTurnResponseCreated = false;
    this.currentTurnQuietFrames = 0;
    this.currentTurnFallbackIssued = false;
    this.clearForceCommitTimer();

    const websocketUrl =
      normalizeNonEmptyString(options.provider.websocketUrl) ??
      `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(options.modelId)}`;
    const connectStartedAt = Date.now();
    debugVoice("voice provider connect start", {
      providerId: options.providerId,
      modelId: options.modelId,
      url: websocketUrl,
    });
    this.emit("state", { state: "connecting" } satisfies VoiceStateEvent);
    this.ws = await createWebSocket(websocketUrl, {
      Authorization: `Bearer ${apiKey}`,
      "OpenAI-Beta": "realtime=v1",
      ...options.provider.headers,
    });
    debugVoice("voice provider connect complete", {
      providerId: options.providerId,
      modelId: options.modelId,
      url: websocketUrl,
      elapsedMs: voiceDebugElapsedMs(connectStartedAt),
      toolCount: options.tools.length,
      historyCount: options.history.length,
    });

    this.ws.on("message", (data, isBinary) => {
      if (isBinary) {
        return;
      }
      const raw = typeof data === "string" ? data : Buffer.isBuffer(data) ? data.toString("utf8") : (data as Buffer).toString("utf8");
      const event = parseJsonObject(raw);
      if (!event) {
        return;
      }
      this.handleEvent(event);
    });
    this.ws.on("close", () => {
      this.emit("state", { state: "closed" } satisfies VoiceStateEvent);
    });
    this.ws.on("error", (cause) => {
      this.emit("error", {
        message: "openai realtime websocket error",
        cause,
      } satisfies VoiceErrorEvent);
    });

    const inputAudioFormatType = normalizeNonEmptyString(options.provider.inputAudioFormat);
    const outputAudioFormatType = normalizeNonEmptyString(options.provider.outputAudioFormat);
    const inputFormat = {
      type: inputAudioFormatType === "pcm16" || !inputAudioFormatType ? "audio/pcm" : inputAudioFormatType,
      rate: options.sampleRateHz,
    };
    const outputFormat = {
      type:
        outputAudioFormatType === "pcm16" || !outputAudioFormatType
          ? "audio/pcm"
          : outputAudioFormatType,
      rate: options.sampleRateHz,
    };
    const sessionUpdate: Record<string, unknown> = {
      type: "session.update",
      session: {
        type: "realtime",
        instructions: options.instructions,
        output_modalities: ["audio"],
        audio: {
          input: {
            format: inputFormat,
            turn_detection: {
              type: "server_vad",
            },
          },
          output: {
            format: outputFormat,
          },
        },
        tools: toOpenAIRealtimeTools(options.tools),
        tool_choice: "auto",
      },
    };
    const transcriptionModelId =
      normalizeNonEmptyString(options.provider.transcriptionModelId) ??
      defaultTranscriptionModelIdForProvider(options.providerId);
    if (transcriptionModelId) {
      const session = sessionUpdate.session as Record<string, unknown>;
      const audio = session.audio as Record<string, unknown>;
      const input = audio.input as Record<string, unknown>;
      input.transcription = { model: transcriptionModelId };
    }
    debugVoice("voice provider bootstrap", {
      providerId: options.providerId,
      modelId: options.modelId,
      sampleRateHz: options.sampleRateHz,
      toolCount: options.tools.length,
      historyCount: options.history.length,
    });
    this.sendJson(sessionUpdate);
    this.emit("state", { state: "connected" } satisfies VoiceStateEvent);
  }

  sendAudio(audio: Buffer): void {
    this.audioFramesSent += 1;
    if (this.firstAudioSentAt === null) {
      this.firstAudioSentAt = Date.now();
    }
    debugVoice("voice websocket send", {
      providerId: this.providerId,
      frameType: "input_audio_buffer.append",
      byteLength: audio.byteLength,
      audioFrameCount: this.audioFramesSent,
    });
    this.sendJson({
      type: "input_audio_buffer.append",
      audio: audio.toString("base64"),
    });
    this.maybeForceCommitAfterQuietAudio(audio);
    this.maybeWarnIfProviderStalled();
  }

  sendText(text: string): void {
    const normalized = text.trim();
    if (!normalized) {
      return;
    }
    this.sendJson({
      type: "conversation.item.create",
      item: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: normalized }],
      },
    });
    this.sendJson({ type: "response.create" });
  }

  sendToolResult(callId: string, output: string): void {
    this.sendJson({
      type: "conversation.item.create",
      item: {
        type: "function_call_output",
        call_id: callId,
        output,
      },
    });
    this.sendJson({ type: "response.create" });
  }

  interrupt(): void {
    this.sendJson({ type: "response.cancel" });
  }

  close(): void {
    debugVoice("voice provider close", { providerId: this.providerId });
    this.clearForceCommitTimer();
    this.ws?.close();
    this.ws = null;
  }

  override getTransportConfig(): VoiceTransportConfig {
    return {
      inputSampleRateHz: this.inputSampleRateHz,
      outputSampleRateHz: this.outputSampleRateHz,
      sampleRateHz: this.outputSampleRateHz,
    };
  }

  private clearForceCommitTimer(): void {
    if (this.forceCommitTimer !== null) {
      clearTimeout(this.forceCommitTimer);
      this.forceCommitTimer = null;
    }
  }

  private armForceCommitTimer(): void {
    if (
      !isOpenAIRealtimeDebugForceCommitEnabled() ||
      !this.speechActive ||
      this.currentTurnFallbackIssued ||
      this.currentTurnResponseCreated
    ) {
      return;
    }
    this.clearForceCommitTimer();
    this.forceCommitTimer = setTimeout(() => {
      this.forceCommitTimer = null;
      this.forceCommitCurrentTurn("idle-timeout");
    }, DEBUG_OPENAI_FORCE_COMMIT_IDLE_MS);
    this.forceCommitTimer.unref?.();
  }

  private forceCommitCurrentTurn(
    reason: "idle-timeout" | "quiet-audio-threshold",
    metrics?: ReturnType<typeof measurePcm16AudioBuffer>,
  ): void {
    if (
      !isOpenAIRealtimeDebugForceCommitEnabled() ||
      !this.speechActive ||
      this.currentTurnFallbackIssued ||
      this.currentTurnResponseCreated
    ) {
      return;
    }
    this.currentTurnFallbackIssued = true;
    this.clearForceCommitTimer();
    debugVoice("voice provider fallback", {
      providerId: this.providerId,
      modelId: this.modelId,
      reason,
      audioFrameCount: this.audioFramesSent,
      quietFrameCount: this.currentTurnQuietFrames,
      ...(metrics
        ? {
            rms: roundVoiceAudioMetric(metrics.rms),
            peak: roundVoiceAudioMetric(metrics.peak),
            nonZeroRatio: roundVoiceAudioMetric(metrics.nonZeroRatio),
          }
        : {}),
    });
    this.sendJson({ type: "input_audio_buffer.commit" });
    this.sendJson({ type: "response.create" });
  }

  private maybeForceCommitAfterQuietAudio(audio: Buffer): void {
    if (
      !isOpenAIRealtimeDebugForceCommitEnabled() ||
      !this.speechActive ||
      this.currentTurnFallbackIssued ||
      this.currentTurnResponseCreated
    ) {
      return;
    }
    const metrics = measurePcm16AudioBuffer(audio, this.inputSampleRateHz);
    const isQuiet =
      metrics.rms <= DEBUG_OPENAI_FORCE_COMMIT_RMS_THRESHOLD &&
      metrics.peak <= DEBUG_OPENAI_FORCE_COMMIT_PEAK_THRESHOLD;
    if (isQuiet) {
      this.currentTurnQuietFrames += 1;
      if (this.currentTurnQuietFrames >= DEBUG_OPENAI_FORCE_COMMIT_QUIET_FRAME_COUNT) {
        this.forceCommitCurrentTurn("quiet-audio-threshold", metrics);
        return;
      }
    } else {
      this.currentTurnQuietFrames = 0;
    }
    this.armForceCommitTimer();
  }

  private recordProviderEvent(eventType: string): void {
    this.providerEventCount += 1;
    if (this.firstProviderEventAt === null) {
      this.firstProviderEventAt = Date.now();
    }
    debugVoice("voice provider event", {
      providerId: this.providerId,
      eventType,
    });
  }

  private applyEffectiveSessionTransport(session: Record<string, unknown> | null): void {
    const inputFormat = resolveRealtimeAudioFormat(session, "input");
    const outputFormat = resolveRealtimeAudioFormat(session, "output");
    this.inputSampleRateHz = inputFormat?.sampleRateHz ?? this.inputSampleRateHz;
    this.outputSampleRateHz = outputFormat?.sampleRateHz ?? this.outputSampleRateHz;
  }

  private logSessionDiagnostics(eventType: string, session: Record<string, unknown> | null): void {
    const modalities = Array.isArray(session?.modalities)
      ? session.modalities.filter((entry): entry is string => typeof entry === "string")
      : Array.isArray(session?.output_modalities)
        ? session.output_modalities.filter((entry): entry is string => typeof entry === "string")
        : [];
    const input = resolveRealtimeAudioSection(session, "input");
    const turnDetection = isRecord(input?.turn_detection)
      ? input.turn_detection
      : isRecord(session?.turn_detection)
        ? session.turn_detection
        : null;
    const transcription = isRecord(input?.transcription)
      ? input.transcription
      : isRecord(session?.input_audio_transcription)
        ? session.input_audio_transcription
        : null;
    const inputFormat = resolveRealtimeAudioFormat(session, "input");
    const outputFormat = resolveRealtimeAudioFormat(session, "output");
    const tools = Array.isArray(session?.tools) ? session.tools : [];
    debugVoice("voice session diagnostics", {
      providerId: this.providerId,
      eventType,
      modalities,
      turnDetectionType: normalizeNonEmptyString(turnDetection?.type),
      transcriptionModel: normalizeNonEmptyString(transcription?.model),
      inputAudioFormat: inputFormat?.type,
      inputSampleRateHz: inputFormat?.sampleRateHz ?? this.inputSampleRateHz,
      outputAudioFormat: outputFormat?.type,
      outputSampleRateHz: outputFormat?.sampleRateHz ?? this.outputSampleRateHz,
      toolCount: tools.length,
    });
  }

  private maybeWarnIfProviderStalled(): void {
    const now = Date.now();
    if (
      this.firstAudioSentAt !== null &&
      !this.firstSpeechAt &&
      !this.noSpeechWarningEmitted &&
      this.audioFramesSent >= 25 &&
      now - this.firstAudioSentAt >= 3_000
    ) {
      this.noSpeechWarningEmitted = true;
      debugVoice("voice provider warning", {
        providerId: this.providerId,
        modelId: this.modelId,
        reason: "no-speech-detected-after-audio-upload",
        audioFrameCount: this.audioFramesSent,
        elapsedMs: now - this.firstAudioSentAt,
      });
    }
    if (
      this.firstSpeechAt !== null &&
      !this.firstTranscriptAt &&
      !this.noTranscriptWarningEmitted &&
      now - this.firstSpeechAt >= 3_000
    ) {
      this.noTranscriptWarningEmitted = true;
      debugVoice("voice provider warning", {
        providerId: this.providerId,
        modelId: this.modelId,
        reason: "speech-detected-without-transcript",
        elapsedMs: now - this.firstSpeechAt,
      });
    }
    if (
      this.firstSpeechStoppedAt !== null &&
      !this.firstResponseCreatedAt &&
      !this.noResponseWarningEmitted &&
      now - this.firstSpeechStoppedAt >= 2_000
    ) {
      this.noResponseWarningEmitted = true;
      debugVoice("voice provider warning", {
        providerId: this.providerId,
        modelId: this.modelId,
        reason: "speech-stopped-without-response-created",
        elapsedMs: now - this.firstSpeechStoppedAt,
      });
    }
    if (
      this.firstAudioSentAt !== null &&
      this.firstProviderEventAt !== null &&
      !this.firstSpeechAt &&
      !this.bootstrapOnlyWarningEmitted &&
      this.providerEventCount <= 2 &&
      now - this.firstAudioSentAt >= 3_000
    ) {
      this.bootstrapOnlyWarningEmitted = true;
      debugVoice("voice provider warning", {
        providerId: this.providerId,
        modelId: this.modelId,
        reason: "bootstrap-events-only-after-audio-upload",
        audioFrameCount: this.audioFramesSent,
        providerEventCount: this.providerEventCount,
        elapsedMs: now - this.firstAudioSentAt,
      });
    }
  }

  private handleEvent(event: Record<string, unknown>): void {
    const type = normalizeNonEmptyString(event.type);
    if (!type) {
      return;
    }

    this.recordProviderEvent(type);
    debugVoicePayload("voice provider event payload", event, {
      providerId: this.providerId,
      eventType: type,
    });

    switch (type) {
      case "session.created": {
        const session = isRecord(event.session) ? event.session : null;
        this.applyEffectiveSessionTransport(session);
        this.logSessionDiagnostics(type, session);
        this.emit("state", { state: "connected" } satisfies VoiceStateEvent);
        this.maybeWarnIfProviderStalled();
        return;
      }
      case "session.updated": {
        const session = isRecord(event.session) ? event.session : null;
        this.applyEffectiveSessionTransport(session);
        this.logSessionDiagnostics(type, session);
        this.emit("state", { state: "connected" } satisfies VoiceStateEvent);
        this.maybeWarnIfProviderStalled();
        return;
      }
      case "input_audio_buffer.speech_started":
        if (this.firstSpeechAt === null) {
          this.firstSpeechAt = Date.now();
        }
        this.speechActive = true;
        this.currentTurnResponseCreated = false;
        this.currentTurnQuietFrames = 0;
        this.currentTurnFallbackIssued = false;
        this.armForceCommitTimer();
        this.emit("state", {
          state: "listening",
          detail: "speech-start",
        } satisfies VoiceStateEvent);
        return;
      case "input_audio_buffer.speech_stopped":
        if (this.firstSpeechStoppedAt === null) {
          this.firstSpeechStoppedAt = Date.now();
        }
        this.speechActive = false;
        this.currentTurnQuietFrames = 0;
        this.clearForceCommitTimer();
        this.emit("state", {
          state: "listening",
          detail: "speech-stop",
        } satisfies VoiceStateEvent);
        this.maybeWarnIfProviderStalled();
        return;
      case "response.created":
        if (this.firstResponseCreatedAt === null) {
          this.firstResponseCreatedAt = Date.now();
        }
        this.currentTurnResponseCreated = true;
        this.clearForceCommitTimer();
        this.emit("state", { state: "responding" } satisfies VoiceStateEvent);
        return;
      case "response.done":
        this.speechActive = false;
        this.currentTurnResponseCreated = false;
        this.currentTurnQuietFrames = 0;
        this.currentTurnFallbackIssued = false;
        this.clearForceCommitTimer();
        this.emit("state", { state: "connected" } satisfies VoiceStateEvent);
        return;
      case "conversation.item.input_audio_transcription.delta": {
        const delta = normalizeTranscriptDelta(event.delta);
        if (delta) {
          if (this.firstTranscriptAt === null) {
            this.firstTranscriptAt = Date.now();
          }
          debugVoice("voice transcript event", { providerId: this.providerId, eventType: type, role: "user", final: false, textLength: delta.length });
          this.emit("transcript", {
            role: "user",
            text: delta,
            final: false,
          } satisfies VoiceTranscriptEvent);
        }
        return;
      }
      case "conversation.item.input_audio_transcription.completed": {
        const transcript = normalizeNonEmptyString(event.transcript);
        if (transcript) {
          if (this.firstTranscriptAt === null) {
            this.firstTranscriptAt = Date.now();
          }
          debugVoice("voice transcript event", { providerId: this.providerId, eventType: type, role: "user", final: true, textLength: transcript.length });
          this.emit("transcript", {
            role: "user",
            text: transcript,
            final: true,
          } satisfies VoiceTranscriptEvent);
        }
        return;
      }
      case "response.audio_transcript.delta":
      case "response.output_audio_transcript.delta": {
        const delta = normalizeTranscriptDelta(event.delta);
        if (delta) {
          if (this.firstTranscriptAt === null) {
            this.firstTranscriptAt = Date.now();
          }
          debugVoice("voice transcript event", { providerId: this.providerId, eventType: type, role: "assistant", final: false, textLength: delta.length });
          this.emit("transcript", {
            role: "assistant",
            text: delta,
            final: false,
          } satisfies VoiceTranscriptEvent);
        }
        return;
      }
      case "response.audio_transcript.done":
      case "response.output_audio_transcript.done": {
        const transcript = normalizeNonEmptyString(event.transcript);
        if (transcript) {
          if (this.firstTranscriptAt === null) {
            this.firstTranscriptAt = Date.now();
          }
          debugVoice("voice transcript event", { providerId: this.providerId, eventType: type, role: "assistant", final: true, textLength: transcript.length });
          this.emit("transcript", {
            role: "assistant",
            text: transcript,
            final: true,
          } satisfies VoiceTranscriptEvent);
        }
        return;
      }
      case "response.audio.delta":
      case "response.output_audio.delta": {
        const delta = normalizeNonEmptyString(event.delta);
        if (delta) {
          const chunk = Buffer.from(delta, "base64");
          if (this.firstAudioResponseAt === null) {
            this.firstAudioResponseAt = Date.now();
          }
          debugVoice("voice provider audio", {
            providerId: this.providerId,
            byteLength: chunk.byteLength,
          });
          this.emit("audio", chunk);
        }
        return;
      }
      case "response.output_item.done": {
        const item = isRecord(event.item) ? event.item : null;
        if (!item) {
          return;
        }
        if (normalizeNonEmptyString(item.type) !== "function_call") {
          return;
        }
        const callId =
          normalizeNonEmptyString(item.call_id) ?? normalizeNonEmptyString(item.id) ?? randomUUID();
        if (this.emittedToolCalls.has(callId)) {
          return;
        }
        this.emittedToolCalls.add(callId);
        const name = normalizeNonEmptyString(item.name) ?? "tool";
        this.emit("tool_call", {
          callId,
          name,
          arguments: parseToolArguments(item.arguments),
        } satisfies VoiceToolCallEvent);
        return;
      }
      case "response.function_call_arguments.delta": {
        const callId = normalizeNonEmptyString(event.call_id);
        const name = normalizeNonEmptyString(event.name);
        const delta = normalizeNonEmptyString(event.delta) ?? "";
        if (!callId || !name) {
          return;
        }
        const existing = this.toolArgumentBuffer.get(callId) ?? { name, argumentsText: "" };
        existing.argumentsText += delta;
        this.toolArgumentBuffer.set(callId, existing);
        return;
      }
      case "response.function_call_arguments.done": {
        const callId = normalizeNonEmptyString(event.call_id);
        const name = normalizeNonEmptyString(event.name);
        if (!callId || !name || this.emittedToolCalls.has(callId)) {
          return;
        }
        this.emittedToolCalls.add(callId);
        const buffered = this.toolArgumentBuffer.get(callId);
        const argumentsText =
          normalizeNonEmptyString(event.arguments) ?? buffered?.argumentsText ?? "{}";
        this.emit("tool_call", {
          callId,
          name,
          arguments: parseToolArguments(argumentsText),
        } satisfies VoiceToolCallEvent);
        this.toolArgumentBuffer.delete(callId);
        return;
      }
      case "error":
        this.emit("error", {
          message:
            normalizeNonEmptyString((event.error as { message?: unknown } | undefined)?.message) ??
            "openai realtime error",
          cause: event.error,
        } satisfies VoiceErrorEvent);
        return;
      default:
        this.maybeWarnIfProviderStalled();
        return;
    }
  }

  private sendJson(payload: Record<string, unknown>): void {
    if (this.ws?.readyState !== WebSocket.OPEN) {
      return;
    }
    debugVoice("voice websocket send", {
      providerId: this.providerId,
      frameType: normalizeNonEmptyString(payload.type) ?? "unknown",
      summary: summarizeVoiceDebugPayload(payload),
    });
    debugVoicePayload("voice websocket send payload", payload, {
      providerId: this.providerId,
      frameType: normalizeNonEmptyString(payload.type) ?? "unknown",
    });
    this.ws.send(JSON.stringify(payload));
  }
}
class GeminiLiveVoiceAdapter extends VoiceAdapter {
  private ws: WebSocket | null = null;

  async connect(options: VoiceAdapterConnectOptions): Promise<void> {
    const apiKey = normalizeNonEmptyString(options.provider.apiKey);
    if (!apiKey) {
      throw new Error(`voice.providers.${options.providerId}.apiKey is required for Gemini live`);
    }

    const modelId = options.modelId.startsWith("models/") ? options.modelId : `models/${options.modelId}`;
    const websocketUrl =
      normalizeNonEmptyString(options.provider.websocketUrl) ??
      `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent?key=${encodeURIComponent(apiKey)}`;

    const connectStartedAt = Date.now();
    debugVoice("voice provider connect start", {
      providerId: options.providerId,
      modelId: options.modelId,
      url: websocketUrl,
    });
    this.emit("state", { state: "connecting" } satisfies VoiceStateEvent);
    this.ws = await createWebSocket(websocketUrl, options.provider.headers ?? {});
    debugVoice("voice provider connect complete", {
      providerId: options.providerId,
      modelId: options.modelId,
      url: websocketUrl,
      elapsedMs: voiceDebugElapsedMs(connectStartedAt),
      toolCount: options.tools.length,
      historyCount: options.history.length,
    });
    this.ws.on("message", (data, isBinary) => {
      if (isBinary) {
        return;
      }
      const raw = typeof data === "string" ? data : Buffer.isBuffer(data) ? data.toString("utf8") : (data as Buffer).toString("utf8");
      const event = parseJsonObject(raw);
      if (!event) {
        return;
      }
      this.handleEvent(event);
    });
    this.ws.on("close", () => {
      this.emit("state", { state: "closed" } satisfies VoiceStateEvent);
    });
    this.ws.on("error", (cause) => {
      this.emit("error", {
        message: "gemini live websocket error",
        cause,
      } satisfies VoiceErrorEvent);
    });

    const setup: Record<string, unknown> = {
      model: modelId,
      generationConfig: {
        responseModalities: ["AUDIO"],
      },
      systemInstruction: {
        parts: [{ text: options.instructions }],
      },
    };
    const tools = toGeminiTools(options.tools);
    if (tools) {
      setup.tools = tools;
    }
    const voiceId = normalizeNonEmptyString(options.provider.voiceId);
    if (voiceId) {
      setup.speechConfig = {
        voiceConfig: {
          prebuiltVoiceConfig: {
            voiceName: voiceId,
          },
        },
      };
    }
    debugVoice("voice provider bootstrap", {
      providerId: options.providerId,
      modelId: options.modelId,
      toolCount: options.tools.length,
      historyCount: options.history.length,
    });
    this.sendJson({ setup });
    this.emit("state", { state: "connected" } satisfies VoiceStateEvent);
  }

  sendAudio(audio: Buffer): void {
    debugVoice("voice websocket send", {
      providerId: "gemini-live",
      frameType: "realtimeInput.mediaChunks",
      byteLength: audio.byteLength,
    });
    this.sendJson({
      realtimeInput: {
        mediaChunks: [
          {
            mimeType: "audio/pcm;rate=16000",
            data: audio.toString("base64"),
          },
        ],
      },
    });
  }

  sendText(text: string): void {
    const normalized = text.trim();
    if (!normalized) {
      return;
    }
    this.sendJson({
      clientContent: {
        turns: [
          {
            role: "user",
            parts: [{ text: normalized }],
          },
        ],
        turnComplete: true,
      },
    });
  }

  sendToolResult(callId: string, output: string, name = "tool"): void {
    this.sendJson({
      toolResponse: {
        functionResponses: [
          {
            id: callId,
            name,
            response: {
              output,
            },
          },
        ],
      },
    });
  }

  interrupt(): void {
    this.emit("state", {
      state: "listening",
      detail: "interrupt-requested",
    } satisfies VoiceStateEvent);
  }

  close(): void {
    debugVoice("voice provider close", { providerId: "gemini-live" });
    this.ws?.close();
    this.ws = null;
  }

  private handleEvent(event: Record<string, unknown>): void {
    debugVoice("voice provider event", {
      providerId: "gemini-live",
      eventType: Object.keys(event).sort().join(",") || "unknown",
    });
    debugVoicePayload("voice provider event payload", event, {
      providerId: "gemini-live",
    });

    if ("setupComplete" in event) {
      this.emit("state", { state: "connected" } satisfies VoiceStateEvent);
    }

    const serverContent = isRecord(event.serverContent) ? event.serverContent : null;
    if (serverContent) {
      const turnComplete = serverContent.turnComplete === true;
      const interrupted = serverContent.interrupted === true;
      if (interrupted) {
        this.emit("state", {
          state: "listening",
          detail: "interrupted",
        } satisfies VoiceStateEvent);
      }

      const inputTranscription = isRecord(serverContent.inputTranscription)
        ? serverContent.inputTranscription
        : null;
      const inputText =
        normalizeNonEmptyString(inputTranscription?.text) ??
        normalizeNonEmptyString(inputTranscription?.transcript);
      if (inputText) {
        this.emit("transcript", {
          role: "user",
          text: inputText,
          final: turnComplete,
        } satisfies VoiceTranscriptEvent);
      }

      const outputTranscription = isRecord(serverContent.outputTranscription)
        ? serverContent.outputTranscription
        : null;
      const outputText =
        normalizeNonEmptyString(outputTranscription?.text) ??
        normalizeNonEmptyString(outputTranscription?.transcript);
      if (outputText) {
        this.emit("state", { state: "responding" } satisfies VoiceStateEvent);
        this.emit("transcript", {
          role: "assistant",
          text: outputText,
          final: turnComplete,
        } satisfies VoiceTranscriptEvent);
      }

      const modelTurn = isRecord(serverContent.modelTurn) ? serverContent.modelTurn : null;
      const parts = Array.isArray(modelTurn?.parts) ? modelTurn.parts : [];
      for (const part of parts) {
        if (!isRecord(part)) {
          continue;
        }
        const inlineData = isRecord(part.inlineData) ? part.inlineData : null;
        const data = normalizeNonEmptyString(inlineData?.data);
        if (!data) {
          continue;
        }
        const chunk = Buffer.from(data, "base64");
        debugVoice("voice provider audio", {
          providerId: "gemini-live",
          byteLength: chunk.byteLength,
        });
        this.emit("audio", chunk);
      }
    }

    const toolCall = isRecord(event.toolCall) ? event.toolCall : null;
    const functionCalls = Array.isArray(toolCall?.functionCalls) ? toolCall.functionCalls : [];
    for (const entry of functionCalls) {
      if (!isRecord(entry)) {
        continue;
      }
      const name = normalizeNonEmptyString(entry.name) ?? "tool";
      const callId = normalizeNonEmptyString(entry.id) ?? randomUUID();
      const args = isRecord(entry.args)
        ? entry.args
        : isRecord(entry.arguments)
          ? entry.arguments
          : parseToolArguments(entry.argsJson ?? entry.argumentsJson);
      this.emit("tool_call", {
        callId,
        name,
        arguments: args,
      } satisfies VoiceToolCallEvent);
    }

    if (isRecord(event.error)) {
      this.emit("error", {
        message: normalizeNonEmptyString(event.error.message) ?? "gemini live error",
        cause: event.error,
      } satisfies VoiceErrorEvent);
    }
  }

  private sendJson(payload: Record<string, unknown>): void {
    if (this.ws?.readyState !== WebSocket.OPEN) {
      return;
    }
    debugVoice("voice websocket send", {
      providerId: "gemini-live",
      frameType: Object.keys(payload).sort().join(",") || "unknown",
      summary: summarizeVoiceDebugPayload(payload),
    });
    debugVoicePayload("voice websocket send payload", payload, {
      providerId: "gemini-live",
    });
    this.ws.send(JSON.stringify(payload));
  }
}

export type VoiceSessionOrchestratorOptions = {
  adapter: VoiceAdapter;
  toolRuntime: VoiceToolRuntime;
  sessionKey: string;
  providerId: string;
  modelId: string;
  agentId?: string;
  persistTranscripts: boolean;
  pauseOnToolCall: boolean;
  interruptOnSpeech: boolean;
};

export class VoiceSessionOrchestrator extends EventEmitter {
  private adapterBound = false;
  private responding = false;
  private assistantPlaybackActive = false;
  // Keep stray provider transcripts caused by speaker bleed from landing as user turns.
  private awaitingFreshUserSpeechStart = false;
  private finalTurnCache = new Set<string>();
  private closed = false;

  constructor(private readonly options: VoiceSessionOrchestratorOptions) {
    super();
  }

  async connect(connectOptions: VoiceAdapterConnectOptions): Promise<void> {
    this.bindAdapter();
    this.emit("state", { state: "connecting" } satisfies VoiceStateEvent);
    await this.options.adapter.connect(connectOptions);
  }

  sendAudio(audio: Buffer): void {
    if (this.closed) {
      return;
    }
    this.options.adapter.sendAudio(audio);
  }

  sendText(text: string): void {
    if (this.closed) {
      return;
    }
    this.options.adapter.sendText(text);
  }

  interrupt(): void {
    if (this.closed) {
      return;
    }
    this.responding = false;
    this.assistantPlaybackActive = false;
    this.awaitingFreshUserSpeechStart = false;
    this.options.adapter.interrupt();
    this.emit("state", {
      state: "listening",
      detail: "interrupt",
    } satisfies VoiceStateEvent);
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.responding = false;
    this.assistantPlaybackActive = false;
    this.awaitingFreshUserSpeechStart = false;
    this.options.adapter.close();
    this.emit("state", { state: "closed" } satisfies VoiceStateEvent);
  }

  private bindAdapter(): void {
    if (this.adapterBound) {
      return;
    }
    this.adapterBound = true;
    this.options.adapter.on("audio", (audio: Buffer) => {
      this.responding = true;
      this.assistantPlaybackActive = true;
      this.awaitingFreshUserSpeechStart = true;
      this.emit("audio", audio);
    });
    this.options.adapter.on("transcript", (event: VoiceTranscriptEvent) => {
      if (event.role === "assistant" && !event.final) {
        this.responding = true;
      }
      if (
        event.role === "user" &&
        event.final &&
        this.awaitingFreshUserSpeechStart
      ) {
        debugVoice("voice transcript persist skipped", {
          providerId: this.options.providerId,
          sessionKey: this.options.sessionKey,
          role: event.role,
          reason: "awaiting-fresh-speech-start",
          assistantPlaybackActive: this.assistantPlaybackActive,
          textLength: event.text.trim().length,
        });
        return;
      }
      if (event.final) {
        if (event.role === "assistant") {
          this.responding = false;
        }
        void this.persistFinalTranscript(event);
      }
      this.emit("transcript", event);
    });
    this.options.adapter.on("state", (event: VoiceStateEvent) => {
      if (event.state === "responding") {
        this.responding = true;
      }
      if (event.state === "connected" || event.state === "listening") {
        if (event.detail === "speech-start" && this.options.interruptOnSpeech && this.responding) {
          this.awaitingFreshUserSpeechStart = false;
          this.options.adapter.interrupt();
          this.assistantPlaybackActive = false;
          this.responding = false;
        }
        if (event.detail === "speech-start") {
          this.awaitingFreshUserSpeechStart = false;
        }
        if (event.state === "listening") {
          if (event.detail === "interrupt") {
            this.assistantPlaybackActive = false;
            this.awaitingFreshUserSpeechStart = false;
          }
          this.responding = false;
        }
        if (event.state === "connected") {
          this.assistantPlaybackActive = false;
          this.responding = false;
        }
      }
      if (event.state === "closed") {
        this.assistantPlaybackActive = false;
        this.awaitingFreshUserSpeechStart = false;
        this.closed = true;
      }
      this.emit("state", event);
    });
    this.options.adapter.on("tool_call", (call: VoiceToolCallEvent) => {
      this.responding = false;
      this.emit("state", {
        state: "tool",
        detail: call.name,
      } satisfies VoiceStateEvent);
      this.emit("tool_call", call);
      void this.handleToolCall(call);
    });
    this.options.adapter.on("error", (event: VoiceErrorEvent) => {
      this.emit("error", event);
    });
  }

  private async handleToolCall(call: VoiceToolCallEvent): Promise<void> {
    const startedAt = Date.now();
    debugVoice("voice tool execution", {
      sessionKey: this.options.sessionKey,
      providerId: this.options.providerId,
      callId: call.callId,
      name: call.name,
      state: "start",
    });
    let result: VoiceToolResultEvent;
    try {
      result = await this.options.toolRuntime.execute(call);
      debugVoice("voice tool execution", {
        sessionKey: this.options.sessionKey,
        providerId: this.options.providerId,
        callId: call.callId,
        name: call.name,
        state: "complete",
        elapsedMs: voiceDebugElapsedMs(startedAt),
        outputLength: result.output.length,
      });
    } catch (cause) {
      debugVoice("voice tool execution", {
        sessionKey: this.options.sessionKey,
        providerId: this.options.providerId,
        callId: call.callId,
        name: call.name,
        state: "error",
        elapsedMs: voiceDebugElapsedMs(startedAt),
        error: cause instanceof Error ? cause.message : String(cause),
      });
      result = {
        ...call,
        output: JSON.stringify({ status: "error", error: String(cause) }),
      };
    }
    this.emit("tool_result", result);
    this.options.adapter.sendToolResult(result.callId, result.output, result.name);
    if (this.options.pauseOnToolCall) {
      this.emit("state", {
        state: "responding",
        detail: `tool:${result.name}`,
      } satisfies VoiceStateEvent);
    }
  }

  private async persistFinalTranscript(event: VoiceTranscriptEvent): Promise<void> {
    if (!this.options.persistTranscripts) {
      return;
    }
    const text = event.text.trim();
    if (!text) {
      debugVoice("voice transcript persist skipped", { providerId: this.options.providerId, sessionKey: this.options.sessionKey, role: event.role, reason: "empty" });
      return;
    }
    const cacheKey = `${event.role}:${text}`;
    if (this.finalTurnCache.has(cacheKey)) {
      debugVoice("voice transcript persist skipped", { providerId: this.options.providerId, sessionKey: this.options.sessionKey, role: event.role, reason: "duplicate", textLength: text.length });
      return;
    }
    this.finalTurnCache.add(cacheKey);
    const startedAt = Date.now();
    debugVoice("voice transcript persist", { providerId: this.options.providerId, sessionKey: this.options.sessionKey, role: event.role, textLength: text.length, state: "start" });
    debugVoicePayload("voice transcript persist payload", { ...event, text }, { providerId: this.options.providerId, sessionKey: this.options.sessionKey });
    await appendVoiceTranscriptMessage({
      sessionKey: this.options.sessionKey,
      role: event.role,
      text,
      providerId: this.options.providerId,
      modelId: this.options.modelId,
      agentId: this.options.agentId,
    });
    debugVoice("voice transcript persist", { providerId: this.options.providerId, sessionKey: this.options.sessionKey, role: event.role, textLength: text.length, state: "complete", elapsedMs: voiceDebugElapsedMs(startedAt) });
  }
}

export async function createVoiceSessionRuntime(params: {
  cfg?: OpenClawConfig;
  voice?: VoiceConfig;
  providerId?: string;
  modelId?: string;
  sessionKey: string;
  sessionId?: string;
  agentId?: string;
  instructions?: string;
  historyLimit?: number;
}): Promise<VoiceSessionRuntime> {
  const resolved = await resolveVoiceSessionConfig({
    cfg: params.cfg,
    voice: params.voice,
    providerId: params.providerId,
  });
  const sessionKey =
    params.sessionKey.trim() || buildDefaultSessionKey(resolved.session.sessionKeyPrefix);
  const history = loadVoiceConversationHistory({
    sessionKey,
    limit: params.historyLimit,
  });
  const toolRuntime = createVoiceToolRuntime({
    cfg: resolved.cfg,
    sessionKey,
    sessionId: params.sessionId,
    agentId: params.agentId,
    modelProvider: resolved.providerId,
    modelId: params.modelId ?? resolved.modelId,
  });
  const adapter = createVoiceAdapter(resolved.providerId);
  const orchestrator = new VoiceSessionOrchestrator({
    adapter,
    toolRuntime,
    sessionKey,
    providerId: resolved.providerId,
    modelId: params.modelId ?? resolved.modelId,
    agentId: params.agentId,
    persistTranscripts: resolved.session.persistTranscripts,
    pauseOnToolCall: resolved.session.pauseOnToolCall,
    interruptOnSpeech: resolved.session.interruptOnSpeech,
  });
  const instructions = buildVoiceInstructions({
    history,
    instructions: params.instructions?.trim() || DEFAULT_GATEWAY_VOICE_INSTRUCTIONS,
  });

  return {
    resolved,
    history,
    toolRuntime,
    adapter,
    orchestrator,
    connect: async () => {
      await orchestrator.connect({
        provider: resolved.provider,
        providerId: resolved.providerId,
        modelId: params.modelId ?? resolved.modelId,
        sampleRateHz: resolved.browser.sampleRateHz,
        instructions,
        tools: toolRuntime.definitions,
        history,
      });
      const transport = adapter.getTransportConfig();
      if (typeof transport?.sampleRateHz === "number") {
        resolved.browser.sampleRateHz = transport.sampleRateHz;
      }
    },
  };
}

