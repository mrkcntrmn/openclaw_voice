import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
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
import type { VoiceSessionTicketStore } from "../voice/session-ticket.js";
import WebSocket, { type WebSocketServer } from "ws";
import {
  validateVoiceWsClientFrame,
  formatValidationErrors,
} from "./protocol/index.js";

const DEFAULT_AUTH_TIMEOUT_MS = 10_000;
const MAX_AUDIO_FRAME_BYTES = 128_000;

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

function sendJson(ws: WebSocket, payload: Record<string, unknown>): void {
  if (ws.readyState !== WebSocket.OPEN) {
    return;
  }
  ws.send(JSON.stringify(payload));
}

function closeWithError(ws: WebSocket, code: number, message: string): void {
  sendJson(ws, { type: "error", message });
  ws.close(code, message);
}

function bindRuntimeEvents(ws: WebSocket, runtime: VoiceSessionRuntime): void {
  runtime.orchestrator.on("state", (event: VoiceStateEvent) => {
    sendJson(ws, { type: "state", ...event });
  });
  runtime.orchestrator.on("transcript", (event: VoiceTranscriptEvent) => {
    sendJson(ws, { type: "transcript", ...event });
  });
  runtime.orchestrator.on("tool_call", (event: VoiceToolCallEvent) => {
    sendJson(ws, { type: "tool_call", ...event });
  });
  runtime.orchestrator.on("tool_result", (event: VoiceToolResultEvent) => {
    sendJson(ws, { type: "tool_result", ...event });
  });
  runtime.orchestrator.on("error", (event: VoiceErrorEvent) => {
    sendJson(ws, { type: "error", message: event.message });
  });
  runtime.orchestrator.on("audio", (audio: Buffer) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(audio, { binary: true });
    }
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
  let runtime: VoiceSessionRuntime | null = null;
  let started = false;
  let sessionTimer: ReturnType<typeof setTimeout> | null = null;

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
      sendJson(params.ws, { type: "error", message: "voice session timeout" });
      activeRuntime.orchestrator.close();
      if (params.ws.readyState === WebSocket.OPEN || params.ws.readyState === WebSocket.CONNECTING) {
        params.ws.close(1000, "voice session timeout");
      }
    }, Math.round(maxSessionMinutes * 60_000));
    sessionTimer.unref?.();
  };

  const authTimer = setTimeout(() => {
    if (!started) {
      closeWithError(params.ws, 4408, "voice start timeout");
    }
  }, authTimeoutMs);
  authTimer.unref?.();

  params.ws.on("close", () => {
    clearTimeout(authTimer);
    clearSessionTimer();
    runtime?.orchestrator.close();
  });
  params.ws.on("error", () => {
    clearTimeout(authTimer);
    clearSessionTimer();
    runtime?.orchestrator.close();
  });
  params.ws.on("message", (data, isBinary) => {
    void (async () => {
      if (!started) {
        if (isBinary) {
          closeWithError(params.ws, 4400, "voice start frame must be JSON");
          return;
        }
      const rawFrame = typeof data === "string" ? data : Buffer.isBuffer(data) ? data.toString("utf8") : (data as Buffer).toString("utf8");
      const frame = parseControlFrame(rawFrame);
        if (!frame || frame.type !== "start") {
          if (!frame && (typeof data === "string" || Buffer.isBuffer(data))) {
          const raw = typeof data === "string" ? data : Buffer.isBuffer(data) ? data.toString("utf8") : (data as Buffer).toString("utf8");
            try {
              const parsed = JSON.parse(raw);
              validateVoiceWsClientFrame(parsed);
              if (validateVoiceWsClientFrame.errors) {
                closeWithError(params.ws, 4400, `invalid voice start frame: ${formatValidationErrors(validateVoiceWsClientFrame.errors)}`);
                return;
              }
            } catch {
              // Not JSON, fall through.
            }
          }
          closeWithError(params.ws, 4400, "expected voice start frame");
          return;
        }

        let sessionKey: string;
        const ticket = normalizeString(frame.ticket);
        if (ticket) {
          const ticketPayload = params.ticketStore.consume(ticket);
          if (!ticketPayload) {
            closeWithError(params.ws, 4401, "voice ticket invalid or expired");
            return;
          }
          sessionKey = ticketPayload.sessionKey;
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
          // Raw auth on /voice/ws stays available for compatibility and debugging.
          const auth = await authorizeWsControlUiGatewayConnect({
            auth: params.resolvedAuth,
            connectAuth: frame.auth ?? null,
            req: params.req,
            trustedProxies,
            allowRealIpFallback,
            rateLimiter: params.rateLimiter,
          });
          if (!auth.ok) {
            closeWithError(params.ws, 4401, auth.reason ?? "voice auth failed");
            return;
          }

          const resolved = await resolveVoiceSessionConfig({ cfg, providerId: frame.provider });
          sessionKey =
            normalizeString(frame.sessionKey) ?? `${resolved.session.sessionKeyPrefix}:browser:${randomUUID()}`;
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

        bindRuntimeEvents(params.ws, runtime);
        await runtime.connect();
        started = true;
        clearTimeout(authTimer);
        armSessionTimer(runtime);
        sendJson(params.ws, {
          type: "ready",
          sessionKey,
          provider: runtime.resolved.providerId,
          modelId: runtime.resolved.modelId,
          transport: {
            sampleRateHz: runtime.resolved.browser.sampleRateHz,
            channels: runtime.resolved.browser.channels,
            frameDurationMs: runtime.resolved.browser.frameDurationMs,
          },
        });
        return;
      }

      if (!runtime) {
        closeWithError(params.ws, 1011, "voice runtime unavailable");
        return;
      }
      if (isBinary) {
        const audio = Buffer.from(data as Buffer);
        if (audio.byteLength > MAX_AUDIO_FRAME_BYTES) {
          sendJson(params.ws, { type: "error", message: "audio frame too large" });
          return;
        }
        runtime.orchestrator.sendAudio(audio);
        return;
      }
      const rawFrameControl = typeof data === "string" ? data : Buffer.isBuffer(data) ? data.toString("utf8") : (data as Buffer).toString("utf8");
      const frame = parseControlFrame(rawFrameControl);
      if (!frame) {
        if (typeof data === "string" || Buffer.isBuffer(data)) {
          const raw = typeof data === "string" ? data : Buffer.isBuffer(data) ? data.toString("utf8") : (data as Buffer).toString("utf8");
          try {
            const parsed = JSON.parse(raw);
            validateVoiceWsClientFrame(parsed);
            if (validateVoiceWsClientFrame.errors) {
              sendJson(params.ws, {
                type: "error",
                message: `invalid voice control frame: ${formatValidationErrors(validateVoiceWsClientFrame.errors)}`,
              });
              return;
            }
          } catch {
            // Not JSON, fall through.
          }
        }
        sendJson(params.ws, { type: "error", message: "invalid voice control frame" });
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
          sendJson(params.ws, { type: "pong" });
          return;
        default:
          return;
      }
    })().catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      closeWithError(params.ws, 1011, message);
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
