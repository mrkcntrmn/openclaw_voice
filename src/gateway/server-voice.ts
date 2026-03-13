import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import path from "node:path";
import type { AuthRateLimiter } from "./auth-rate-limit.js";
import { authorizeWsControlUiGatewayConnect, type ResolvedGatewayAuth } from "./auth.js";
import { loadConfig } from "../config/config.js";
import {
  DEFAULT_VOICE_BROWSER_WS_PATH,
  normalizeVoiceConfig,
  normalizeVoiceSection,
} from "../config/voice.js";
import {
  createVoiceSessionRuntime,
  resolveVoiceSessionConfig,
  type VoiceErrorEvent,
  type VoiceSessionRuntime,
  type VoiceStateEvent,
  type VoiceToolCallEvent,
  type VoiceToolResultEvent,
  type VoiceTranscriptEvent,
} from "../voice/runtime.js";
import {
  createVoiceDebugLogger,
  summarizeVoiceDebugPayload,
  voiceDebugElapsedMs,
} from "../voice/debug.js";
import {
  buildMonoPcm16WavBuffer,
  isVoiceAudioDumpEnabled,
  measurePcm16AudioBuffer,
  roundVoiceAudioMetric,
} from "../voice/audio-debug.js";
import type { VoiceSessionTicketStore } from "../voice/session-ticket.js";
import { resolvePreferredOpenClawTmpDir } from "../infra/tmp-openclaw-dir.js";
import WebSocket, { type WebSocketServer } from "ws";
import {
  validateVoiceWsClientFrame,
  formatValidationErrors,
} from "./protocol/index.js";

const DEFAULT_AUTH_TIMEOUT_MS = 10_000;
const MAX_AUDIO_FRAME_BYTES = 128_000;
const AUDIO_METRICS_LOG_INTERVAL_MS = 250;
const NO_PROVIDER_ACTIVITY_WARNING_MS = 3_000;
const MIN_AUDIO_FRAMES_FOR_PROVIDER_ACTIVITY_WARNING = 25;
const MAX_AUDIO_DUMP_SECONDS = 8;
const voiceDebug = createVoiceDebugLogger("gateway/voice");

type VoiceLogContext = {
  connectionId: string;
  sessionKey?: string;
  providerId?: string;
  authPath?: string;
};

function debugVoice(message: string, meta?: Record<string, unknown>): void {
  voiceDebug.debug(message, meta);
}

function debugVoicePayload(message: string, payload: unknown, meta?: Record<string, unknown>): void {
  voiceDebug.payload(message, payload, meta);
}

function normalizeString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function parseControlFrame(raw: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (validateVoiceWsClientFrame(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

function sendJson(
  ws: WebSocket,
  payload: Record<string, unknown>,
  meta?: VoiceLogContext & Record<string, unknown>,
): void {
  if (ws.readyState !== WebSocket.OPEN) {
    return;
  }
  debugVoice("voice websocket send", {
    ...meta,
    frameType: normalizeString(payload.type) ?? "unknown",
    summary: summarizeVoiceDebugPayload(payload),
  });
  debugVoicePayload("voice websocket send payload", payload, {
    ...meta,
    frameType: normalizeString(payload.type) ?? "unknown",
  });
  ws.send(JSON.stringify(payload));
}

function closeWithError(
  ws: WebSocket,
  code: number,
  message: string,
  meta?: VoiceLogContext & Record<string, unknown>,
): void {
  sendJson(ws, { type: "error", message }, meta);
  ws.close(code, message);
}

async function persistVoiceAudioDump(params: {
  connectionId: string;
  sessionKey?: string;
  providerId?: string;
  sampleRateHz: number;
  pcm: Buffer;
}): Promise<string> {
  const dumpRoot = path.join(resolvePreferredOpenClawTmpDir(), "voice-debug");
  await fs.mkdir(dumpRoot, { recursive: true });
  const filename = `voice-${Date.now()}-${params.connectionId}.wav`;
  const dumpPath = path.join(dumpRoot, filename);
  await fs.writeFile(dumpPath, buildMonoPcm16WavBuffer(params.pcm, params.sampleRateHz), {
    mode: 0o600,
  });
  return dumpPath;
}

function bindRuntimeEvents(
  ws: WebSocket,
  runtime: VoiceSessionRuntime,
  meta: VoiceLogContext & { sessionKey: string; providerId: string },
): void {
  let outboundAudioSeq = 0;

  runtime.orchestrator.on("state", (event: VoiceStateEvent) => {
    debugVoice("voice relay frame", { ...meta, frameType: "state", state: event.state, detail: event.detail });
    sendJson(ws, { type: "state", ...event }, meta);
  });
  runtime.orchestrator.on("transcript", (event: VoiceTranscriptEvent) => {
    debugVoice("voice relay frame", { ...meta, frameType: "transcript", role: event.role, final: event.final, textLength: event.text.length });
    debugVoicePayload("voice relay frame payload", event, { ...meta, frameType: "transcript" });
    sendJson(ws, { type: "transcript", ...event }, meta);
  });
  runtime.orchestrator.on("tool_call", (event: VoiceToolCallEvent) => {
    debugVoice("voice relay frame", { ...meta, frameType: "tool_call", callId: event.callId, name: event.name });
    debugVoicePayload("voice relay frame payload", event, { ...meta, frameType: "tool_call" });
    sendJson(ws, { type: "tool_call", ...event }, meta);
  });
  runtime.orchestrator.on("tool_result", (event: VoiceToolResultEvent) => {
    debugVoice("voice relay frame", { ...meta, frameType: "tool_result", callId: event.callId, name: event.name, outputLength: event.output.length });
    debugVoicePayload("voice relay frame payload", event, { ...meta, frameType: "tool_result" });
    sendJson(ws, { type: "tool_result", ...event }, meta);
  });
  runtime.orchestrator.on("error", (event: VoiceErrorEvent) => {
    debugVoice("voice relay frame", { ...meta, frameType: "error", message: event.message });
    sendJson(ws, { type: "error", message: event.message }, meta);
  });
  runtime.orchestrator.on("audio", (audio: Buffer) => {
    if (ws.readyState !== WebSocket.OPEN) {
      return;
    }
    outboundAudioSeq += 1;
    debugVoice("voice websocket send", {
      ...meta,
      frameType: "audio",
      audioSequence: outboundAudioSeq,
      byteLength: audio.byteLength,
    });
    ws.send(audio, { binary: true });
  });
}

async function handleVoiceConnection(params: {
  ws: WebSocket;
  req: IncomingMessage;
  resolvedAuth: ResolvedGatewayAuth;
  ticketStore: VoiceSessionTicketStore;
  rateLimiter?: AuthRateLimiter;
}): Promise<void> {
  const cfg = normalizeVoiceConfig(loadConfig());
  const trustedProxies = cfg.gateway?.trustedProxies ?? [];
  const allowRealIpFallback = cfg.gateway?.allowRealIpFallback === true;
  const authTimeoutMs = normalizeVoiceSection(cfg.voice)?.browser?.authTimeoutMs ?? DEFAULT_AUTH_TIMEOUT_MS;
  const connectionId = randomUUID();
  let runtime: VoiceSessionRuntime | null = null;
  let started = false;
  let sessionTimer: ReturnType<typeof setTimeout> | null = null;
  let currentSessionKey: string | null = null;
  let currentProviderId: string | null = null;
  let authPath: string | undefined;
  let inboundAudioSeq = 0;
  let firstInboundAudioAt: number | null = null;
  let lastInboundAudioMetricsAt = 0;
  let sawProviderSpeech = false;
  let sawProviderTranscript = false;
  let providerActivityWarningEmitted = false;
  let dumpPersisted = false;
  const audioDumpChunks: Buffer[] = [];
  let audioDumpBytes = 0;

  const baseMeta = (): VoiceLogContext => ({
    connectionId,
    sessionKey: currentSessionKey ?? undefined,
    providerId: currentProviderId ?? undefined,
    authPath,
  });

  const maxAudioDumpBytes = (): number => {
    const sampleRateHz = runtime?.resolved.browser.sampleRateHz ?? 16_000;
    return sampleRateHz * 2 * MAX_AUDIO_DUMP_SECONDS;
  };

  const maybePersistAudioDump = (): void => {
    if (!isVoiceAudioDumpEnabled() || dumpPersisted || audioDumpBytes < 1) {
      return;
    }
    dumpPersisted = true;
    const pcm = Buffer.concat(audioDumpChunks);
    void persistVoiceAudioDump({
      connectionId,
      sessionKey: currentSessionKey ?? undefined,
      providerId: currentProviderId ?? undefined,
      sampleRateHz: runtime?.resolved.browser.sampleRateHz ?? 16_000,
      pcm,
    })
      .then((dumpPath) => {
        const durationMs = roundVoiceAudioMetric(
          (pcm.byteLength / 2 / (runtime?.resolved.browser.sampleRateHz ?? 16_000)) * 1000,
        );
        debugVoice("voice audio dump", {
          ...baseMeta(),
          dumpPath,
          byteLength: pcm.byteLength,
          durationMs,
        });
      })
      .catch((error) => {
        debugVoice("voice audio dump", {
          ...baseMeta(),
          error: error instanceof Error ? error.message : String(error),
          state: "error",
        });
      });
  };

  debugVoice("voice websocket open", {
    connectionId,
    remoteAddress: params.req.socket.remoteAddress,
    url: params.req.url,
  });

  const clearSessionTimer = () => {
    if (sessionTimer !== null) {
      clearTimeout(sessionTimer);
      sessionTimer = null;
    }
  };

  const armSessionTimer = (activeRuntime: VoiceSessionRuntime) => {
    clearSessionTimer();
    const maxSessionMinutes = activeRuntime.resolved.deployment.websocket.maxSessionMinutes;
    if (typeof maxSessionMinutes !== "number" || !Number.isFinite(maxSessionMinutes) || maxSessionMinutes <= 0) {
      return;
    }
    sessionTimer = setTimeout(() => {
      sendJson(params.ws, { type: "error", message: "voice session timeout" }, baseMeta());
      activeRuntime.orchestrator.close();
      if (params.ws.readyState === WebSocket.OPEN || params.ws.readyState === WebSocket.CONNECTING) {
        params.ws.close(1000, "voice session timeout");
      }
    }, Math.round(maxSessionMinutes * 60_000));
    sessionTimer.unref?.();
  };

  const authTimer = setTimeout(() => {
    if (!started) {
      closeWithError(params.ws, 4408, "voice start timeout", baseMeta());
    }
  }, authTimeoutMs);
  authTimer.unref?.();

  params.ws.on("close", (code, reasonBuffer) => {
    debugVoice("voice websocket closed", {
      ...baseMeta(),
      code,
      reason: reasonBuffer.toString("utf8") || undefined,
      started,
    });
    clearTimeout(authTimer);
    clearSessionTimer();
    maybePersistAudioDump();
    runtime?.orchestrator.close();
  });
  params.ws.on("error", (error) => {
    debugVoice("voice websocket error", {
      ...baseMeta(),
      started,
      error: error instanceof Error ? error.message : String(error),
    });
    clearTimeout(authTimer);
    clearSessionTimer();
    maybePersistAudioDump();
    runtime?.orchestrator.close();
  });
  params.ws.on("message", (data, isBinary) => {
    void (async () => {
      if (!started) {
        if (isBinary) {
          debugVoice("voice websocket receive", {
            ...baseMeta(),
            frameType: "audio",
            dropped: true,
            reason: "binary-before-start",
          });
          closeWithError(params.ws, 4400, "voice start frame must be JSON", baseMeta());
          return;
        }
        const rawFrame = typeof data === "string" ? data : Buffer.isBuffer(data) ? data.toString("utf8") : (data as Buffer).toString("utf8");
        const frame = parseControlFrame(rawFrame);
        debugVoice("voice websocket receive", {
          ...baseMeta(),
          frameType: frame?.type ?? "invalid",
          started: false,
        });
        debugVoicePayload("voice websocket receive payload", frame ?? rawFrame, {
          ...baseMeta(),
          started: false,
        });
        if (!frame || frame.type !== "start") {
          if (!frame && (typeof data === "string" || Buffer.isBuffer(data))) {
            try {
              const parsed = JSON.parse(rawFrame);
              validateVoiceWsClientFrame(parsed);
              if (validateVoiceWsClientFrame.errors) {
                closeWithError(
                  params.ws,
                  4400,
                  `invalid voice start frame: ${formatValidationErrors(validateVoiceWsClientFrame.errors)}`,
                  baseMeta(),
                );
                return;
              }
            } catch {
              // Not JSON, fall through.
            }
          }
          closeWithError(params.ws, 4400, "expected voice start frame", baseMeta());
          return;
        }

        debugVoice("voice start frame received", {
          ...baseMeta(),
          hasTicket: Boolean(normalizeString(frame.ticket)),
          requestedProviderId: normalizeString(frame.provider),
          requestedSessionKey: normalizeString(frame.sessionKey),
        });

        let sessionKey: string;
        const ticket = normalizeString(frame.ticket);
        if (ticket) {
          authPath = "ticket";
          const ticketPayload = params.ticketStore.consume(ticket);
          if (!ticketPayload) {
            closeWithError(params.ws, 4401, "voice ticket invalid or expired", baseMeta());
            return;
          }
          sessionKey = ticketPayload.sessionKey;
          currentSessionKey = sessionKey;
          currentProviderId = ticketPayload.providerId;
          debugVoice("voice ticket resolved", { ...baseMeta(), ticket, sessionKey, providerId: ticketPayload.providerId, agentId: ticketPayload.agentId ?? undefined });
          runtime = await createVoiceSessionRuntime({
            cfg: ticketPayload.cfg,
            voice: ticketPayload.voice,
            providerId: ticketPayload.providerId,
            modelId: ticketPayload.modelId,
            sessionKey,
            agentId: ticketPayload.agentId,
            instructions: ticketPayload.instructions,
          });
        } else {
          authPath = "raw-auth";
          const auth = await authorizeWsControlUiGatewayConnect({
            auth: params.resolvedAuth,
            connectAuth: frame.auth ?? null,
            req: params.req,
            trustedProxies,
            allowRealIpFallback,
            rateLimiter: params.rateLimiter,
          });
          if (!auth.ok) {
            closeWithError(params.ws, 4401, auth.reason ?? "voice auth failed", baseMeta());
            return;
          }

          const resolved = await resolveVoiceSessionConfig({ cfg, providerId: frame.provider });
          sessionKey =
            normalizeString(frame.sessionKey) ?? `${resolved.session.sessionKeyPrefix}:browser:${randomUUID()}`;
          currentSessionKey = sessionKey;
          currentProviderId = resolved.providerId;
          debugVoice("voice session resolved", { ...baseMeta(), sessionKey, providerId: resolved.providerId, requestedProviderId: normalizeString(frame.provider), agentId: normalizeString(frame.agentId) });
          runtime = await createVoiceSessionRuntime({
            cfg,
            voice: resolved.voice,
            providerId: resolved.providerId,
            modelId: normalizeString(frame.modelId) ?? resolved.modelId,
            sessionKey,
            agentId: normalizeString(frame.agentId),
            instructions: normalizeString(frame.instructions),
          });
        }

        runtime.orchestrator.on("state", (event: VoiceStateEvent) => {
          if (event.detail === "speech-start" || event.detail === "speech-stop") {
            sawProviderSpeech = true;
          }
        });
        runtime.orchestrator.on("transcript", () => {
          sawProviderTranscript = true;
        });

        const connectStartedAt = Date.now();
        bindRuntimeEvents(params.ws, runtime, {
          ...baseMeta(),
          sessionKey,
          providerId: runtime.resolved.providerId,
        });
        debugVoice("voice runtime connect start", { ...baseMeta(), sessionKey, providerId: runtime.resolved.providerId, modelId: runtime.resolved.modelId });
        await runtime.connect();
        started = true;
        clearTimeout(authTimer);
        armSessionTimer(runtime);
        debugVoice("voice runtime connect complete", { ...baseMeta(), sessionKey, providerId: runtime.resolved.providerId, modelId: runtime.resolved.modelId, elapsedMs: voiceDebugElapsedMs(connectStartedAt) });
        sendJson(
          params.ws,
          {
            type: "ready",
            sessionKey,
            provider: runtime.resolved.providerId,
            modelId: runtime.resolved.modelId,
            transport: {
              sampleRateHz: runtime.resolved.browser.sampleRateHz,
              channels: runtime.resolved.browser.channels,
              frameDurationMs: runtime.resolved.browser.frameDurationMs,
            },
          },
          baseMeta(),
        );
        return;
      }

      if (!runtime) {
        closeWithError(params.ws, 1011, "voice runtime unavailable", baseMeta());
        return;
      }
      if (isBinary) {
        const audio = Buffer.from(data as Buffer);
        inboundAudioSeq += 1;
        debugVoice("voice websocket receive", {
          ...baseMeta(),
          frameType: "audio",
          audioSequence: inboundAudioSeq,
          byteLength: audio.byteLength,
        });
        if (audio.byteLength > MAX_AUDIO_FRAME_BYTES) {
          debugVoice("voice websocket receive", {
            ...baseMeta(),
            frameType: "audio",
            audioSequence: inboundAudioSeq,
            dropped: true,
            reason: "too-large",
          });
          sendJson(params.ws, { type: "error", message: "audio frame too large" }, baseMeta());
          return;
        }

        const now = Date.now();
        const metrics = measurePcm16AudioBuffer(audio, runtime.resolved.browser.sampleRateHz);
        if (firstInboundAudioAt === null) {
          firstInboundAudioAt = now;
        }
        if (
          inboundAudioSeq === 1 ||
          now - lastInboundAudioMetricsAt >= AUDIO_METRICS_LOG_INTERVAL_MS
        ) {
          lastInboundAudioMetricsAt = now;
          debugVoice("voice audio metrics", {
            ...baseMeta(),
            audioSequence: inboundAudioSeq,
            sampleCount: metrics.sampleCount,
            byteLength: metrics.byteLength,
            rms: roundVoiceAudioMetric(metrics.rms),
            peak: roundVoiceAudioMetric(metrics.peak),
            nonZeroRatio: roundVoiceAudioMetric(metrics.nonZeroRatio),
            clippedRatio: roundVoiceAudioMetric(metrics.clippedRatio),
            durationMs: roundVoiceAudioMetric(metrics.durationMs),
          });
        }
        if (
          !providerActivityWarningEmitted &&
          !sawProviderSpeech &&
          !sawProviderTranscript &&
          firstInboundAudioAt !== null &&
          inboundAudioSeq >= MIN_AUDIO_FRAMES_FOR_PROVIDER_ACTIVITY_WARNING &&
          now - firstInboundAudioAt >= NO_PROVIDER_ACTIVITY_WARNING_MS
        ) {
          providerActivityWarningEmitted = true;
          debugVoice("voice provider warning", {
            ...baseMeta(),
            reason: "no-provider-speech-or-transcript-after-audio",
            audioFrameCount: inboundAudioSeq,
            elapsedMs: now - firstInboundAudioAt,
          });
        }
        if (isVoiceAudioDumpEnabled() && audioDumpBytes < maxAudioDumpBytes()) {
          const remaining = maxAudioDumpBytes() - audioDumpBytes;
          const chunk = audio.subarray(0, Math.min(remaining, audio.byteLength));
          if (chunk.byteLength > 0) {
            audioDumpChunks.push(Buffer.from(chunk));
            audioDumpBytes += chunk.byteLength;
          }
        }
        runtime.orchestrator.sendAudio(audio);
        return;
      }
      const rawFrameControl = typeof data === "string" ? data : Buffer.isBuffer(data) ? data.toString("utf8") : (data as Buffer).toString("utf8");
      const frame = parseControlFrame(rawFrameControl);
      debugVoice("voice websocket receive", {
        ...baseMeta(),
        frameType: frame?.type ?? "invalid",
        started: true,
      });
      debugVoicePayload("voice websocket receive payload", frame ?? rawFrameControl, {
        ...baseMeta(),
        started: true,
      });
      if (!frame) {
        if (typeof data === "string" || Buffer.isBuffer(data)) {
          try {
            const parsed = JSON.parse(rawFrameControl);
            validateVoiceWsClientFrame(parsed);
            if (validateVoiceWsClientFrame.errors) {
              sendJson(
                params.ws,
                {
                  type: "error",
                  message: `invalid voice control frame: ${formatValidationErrors(validateVoiceWsClientFrame.errors)}`,
                },
                baseMeta(),
              );
              return;
            }
          } catch {
            // Not JSON, fall through.
          }
        }
        sendJson(params.ws, { type: "error", message: "invalid voice control frame" }, baseMeta());
        return;
      }
      switch (frame.type) {
        case "interrupt":
          runtime.orchestrator.interrupt();
          return;
        case "stop":
          runtime.orchestrator.close();
          params.ws.close(1000, "voice stop");
          return;
        case "text":
          runtime.orchestrator.sendText(normalizeString(frame.text) ?? "");
          return;
        case "ping":
          sendJson(params.ws, { type: "pong" }, baseMeta());
          return;
        default:
          return;
      }
    })().catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      closeWithError(params.ws, 1011, message, baseMeta());
    });
  });
}

export function resolveGatewayVoiceWsPath(): string {
  const cfg = normalizeVoiceConfig(loadConfig());
  const path = normalizeVoiceSection(cfg.voice)?.browser?.wsPath ?? DEFAULT_VOICE_BROWSER_WS_PATH;
  return path.startsWith("/") ? path : `/${path}`;
}

export function attachGatewayVoiceWsHandlers(params: {
  voiceWss: WebSocketServer;
  resolvedAuth: ResolvedGatewayAuth;
  ticketStore: VoiceSessionTicketStore;
  rateLimiter?: AuthRateLimiter;
}): void {
  params.voiceWss.on("connection", (ws, req) => {
    void handleVoiceConnection({
      ws,
      req,
      resolvedAuth: params.resolvedAuth,
      ticketStore: params.ticketStore,
      rateLimiter: params.rateLimiter,
    });
  });
}


