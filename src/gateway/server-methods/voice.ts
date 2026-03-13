import { randomUUID } from "node:crypto";
import { readConfigFileSnapshot } from "../../config/config.js";
import { redactConfigObject } from "../../config/redact-snapshot.js";
import {
  buildVoiceConfigResponseFromConfig,
  listVoiceConfigDeprecations,
  normalizeVoiceConfig,
} from "../../config/voice.js";
import { createVoiceDebugLogger, summarizeVoiceDebugPayload, voiceDebugElapsedMs } from "../../voice/debug.js";
import { resolveVoiceSessionConfig } from "../../voice/runtime.js";
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validateVoiceConfigParams,
  validateVoiceSessionCreateParams,
} from "../protocol/index.js";
import type { GatewayRequestHandlers } from "./types.js";

const ADMIN_SCOPE = "operator.admin";
const TALK_SECRETS_SCOPE = "operator.talk.secrets";
const VOICE_SECRETS_SCOPE = "operator.voice.secrets";
const voiceDebug = createVoiceDebugLogger("gateway/voice");

function canReadVoiceSecrets(client: { connect?: { scopes?: string[] } } | null): boolean {
  const scopes = Array.isArray(client?.connect?.scopes) ? client.connect.scopes : [];
  return (
    scopes.includes(ADMIN_SCOPE) ||
    scopes.includes(TALK_SECRETS_SCOPE) ||
    scopes.includes(VOICE_SECRETS_SCOPE)
  );
}

function normalizeString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export const voiceHandlers: GatewayRequestHandlers = {
  "voice.config": async ({ params, respond, client }) => {
    const startedAt = Date.now();
    const includeSecrets = Boolean((params as { includeSecrets?: boolean }).includeSecrets);
    const canReadSecrets = canReadVoiceSecrets(client);

    voiceDebug.debug("voice config request", {
      includeSecrets,
      secretsAllowed: canReadSecrets,
    });
    voiceDebug.payload("voice config request payload", params, {
      includeSecrets,
      secretsAllowed: canReadSecrets,
    });

    if (!validateVoiceConfigParams(params)) {
      const message = `invalid voice.config params: ${formatValidationErrors(validateVoiceConfigParams.errors)}`;
      voiceDebug.debug("voice config response", {
        ok: false,
        includeSecrets,
        secretsAllowed: canReadSecrets,
        elapsedMs: voiceDebugElapsedMs(startedAt),
        reason: "validation",
      });
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, message));
      return;
    }

    if (includeSecrets && !canReadSecrets) {
      voiceDebug.debug("voice config response", {
        ok: false,
        includeSecrets,
        secretsAllowed: false,
        elapsedMs: voiceDebugElapsedMs(startedAt),
        reason: "missing-scope",
      });
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `missing scope: ${VOICE_SECRETS_SCOPE}`),
      );
      return;
    }

    const snapshot = await readConfigFileSnapshot();
    const configPayload: Record<string, unknown> = {};
    const configSource = includeSecrets ? snapshot.config : redactConfigObject(snapshot.config);
    const voice = buildVoiceConfigResponseFromConfig(configSource);
    if (voice) {
      configPayload.voice = voice;
    }

    const sessionMainKey = snapshot.config.session?.mainKey;
    if (typeof sessionMainKey === "string") {
      configPayload.session = { mainKey: sessionMainKey };
    }

    const seamColor = snapshot.config.ui?.seamColor;
    if (typeof seamColor === "string") {
      configPayload.ui = { seamColor };
    }

    const browser = voice && typeof voice === "object" && voice !== null && "browser" in voice
      ? (voice as { browser?: { enabled?: boolean } }).browser
      : undefined;
    const deprecations = voice && typeof voice === "object" && voice !== null && "deprecations" in voice
      ? (voice as { deprecations?: unknown[] }).deprecations
      : undefined;
    const responsePayload = { config: configPayload };

    voiceDebug.debug("voice config response", {
      ok: true,
      includeSecrets,
      secretsAllowed: canReadSecrets,
      hasVoiceConfig: Boolean(voice),
      browserEnabled: browser?.enabled !== false,
      deprecationCount: Array.isArray(deprecations) ? deprecations.length : 0,
      elapsedMs: voiceDebugElapsedMs(startedAt),
      responseSummary: summarizeVoiceDebugPayload(responsePayload),
    });
    voiceDebug.payload("voice config response payload", responsePayload, {
      includeSecrets,
      elapsedMs: voiceDebugElapsedMs(startedAt),
    });

    respond(true, responsePayload, undefined);
  },
  "voice.session.create": async ({ params, respond, context }) => {
    const startedAt = Date.now();
    const providerId = normalizeString((params as { provider?: unknown }).provider);
    const sessionKeyInput = normalizeString((params as { sessionKey?: unknown }).sessionKey);
    const modelIdOverride = normalizeString((params as { modelId?: unknown }).modelId);
    const agentId = normalizeString((params as { agentId?: unknown }).agentId);

    voiceDebug.debug("voice bootstrap request", {
      providerId,
      sessionKey: sessionKeyInput,
      modelId: modelIdOverride,
      agentId,
    });
    voiceDebug.payload("voice bootstrap request payload", params, {
      providerId,
      sessionKey: sessionKeyInput,
      modelId: modelIdOverride,
      agentId,
    });

    if (!validateVoiceSessionCreateParams(params)) {
      const message = `invalid voice.session.create params: ${formatValidationErrors(validateVoiceSessionCreateParams.errors)}`;
      voiceDebug.debug("voice bootstrap response", {
        ok: false,
        reason: "validation",
        elapsedMs: voiceDebugElapsedMs(startedAt),
      });
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, message));
      return;
    }

    if (!context.voiceSessionTickets) {
      voiceDebug.debug("voice bootstrap response", {
        ok: false,
        reason: "ticket-store-unavailable",
        elapsedMs: voiceDebugElapsedMs(startedAt),
      });
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, "voice session bootstrap is unavailable"),
      );
      return;
    }

    const snapshot = await readConfigFileSnapshot();
    const normalizedConfig = normalizeVoiceConfig(snapshot.config);
    const instructions = normalizeString((params as { instructions?: unknown }).instructions);

    let resolved: Awaited<ReturnType<typeof resolveVoiceSessionConfig>>;
    try {
      resolved = await resolveVoiceSessionConfig({
        cfg: normalizedConfig,
        providerId,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      voiceDebug.debug("voice bootstrap response", {
        ok: false,
        reason: "resolve-config",
        providerId,
        elapsedMs: voiceDebugElapsedMs(startedAt),
        error: message,
      });
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, message));
      return;
    }

    if (!resolved.browser.enabled) {
      voiceDebug.debug("voice bootstrap response", {
        ok: false,
        reason: "browser-disabled",
        providerId: resolved.providerId,
        elapsedMs: voiceDebugElapsedMs(startedAt),
      });
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, "browser voice is disabled in the current gateway config"),
      );
      return;
    }

    const sessionKey =
      sessionKeyInput ?? `${resolved.session.sessionKeyPrefix}:browser:${randomUUID()}`;
    const modelId = modelIdOverride ?? resolved.modelId;
    const issued = context.voiceSessionTickets.issue({
      cfg: normalizedConfig,
      voice: resolved.voice,
      providerId: resolved.providerId,
      modelId,
      sessionKey,
      ...(agentId ? { agentId } : {}),
      ...(instructions ? { instructions } : {}),
    });
    const deprecations = listVoiceConfigDeprecations(normalizedConfig);

    const responsePayload = {
      ticket: issued.ticket,
      expiresAt: issued.expiresAt,
      sessionKey,
      provider: resolved.providerId,
      modelId,
      transport: {
        wsPath: resolved.browser.wsPath,
        sampleRateHz: resolved.browser.sampleRateHz,
        channels: resolved.browser.channels,
        frameDurationMs: resolved.browser.frameDurationMs,
      },
      session: {
        interruptOnSpeech: resolved.session.interruptOnSpeech,
        pauseOnToolCall: resolved.session.pauseOnToolCall,
        persistTranscripts: resolved.session.persistTranscripts,
        transcriptSource: resolved.session.transcriptSource,
        ...(typeof resolved.session.silenceTimeoutMs === "number"
          ? { silenceTimeoutMs: resolved.session.silenceTimeoutMs }
          : {}),
        sharedChatHistory: resolved.session.sharedChatHistory,
        sessionKeyPrefix: resolved.session.sessionKeyPrefix,
      },
      ...(deprecations.length > 0 ? { deprecations } : {}),
    };

    voiceDebug.debug("voice bootstrap response", {
      ok: true,
      providerId: resolved.providerId,
      modelId,
      sessionKey,
      ticket: issued.ticket,
      expiresAt: issued.expiresAt,
      agentId,
      elapsedMs: voiceDebugElapsedMs(startedAt),
      responseSummary: summarizeVoiceDebugPayload(responsePayload),
    });
    voiceDebug.payload("voice bootstrap response payload", responsePayload, {
      providerId: resolved.providerId,
      sessionKey,
      elapsedMs: voiceDebugElapsedMs(startedAt),
    });

    respond(true, responsePayload, undefined);
  },
};
