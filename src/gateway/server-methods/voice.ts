import { randomUUID } from "node:crypto";
import { readConfigFileSnapshot } from "../../config/config.js";
import { redactConfigObject } from "../../config/redact-snapshot.js";
import {
  buildVoiceConfigResponseFromConfig,
  listVoiceConfigDeprecations,
  normalizeVoiceConfig,
} from "../../config/voice.js";
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
    if (!validateVoiceConfigParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid voice.config params: ${formatValidationErrors(validateVoiceConfigParams.errors)}`,
        ),
      );
      return;
    }

    const includeSecrets = Boolean((params as { includeSecrets?: boolean }).includeSecrets);
    if (includeSecrets && !canReadVoiceSecrets(client)) {
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

    respond(true, { config: configPayload }, undefined);
  },
  "voice.session.create": async ({ params, respond, context }) => {
    if (!validateVoiceSessionCreateParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid voice.session.create params: ${formatValidationErrors(validateVoiceSessionCreateParams.errors)}`,
        ),
      );
      return;
    }

    if (!context.voiceSessionTickets) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, "voice session bootstrap is unavailable"),
      );
      return;
    }

    const snapshot = await readConfigFileSnapshot();
    const normalizedConfig = normalizeVoiceConfig(snapshot.config);
    const providerId = normalizeString((params as { provider?: unknown }).provider);
    const sessionKeyInput = normalizeString((params as { sessionKey?: unknown }).sessionKey);
    const modelIdOverride = normalizeString((params as { modelId?: unknown }).modelId);
    const agentId = normalizeString((params as { agentId?: unknown }).agentId);
    const instructions = normalizeString((params as { instructions?: unknown }).instructions);

    let resolved: Awaited<ReturnType<typeof resolveVoiceSessionConfig>>;
    try {
      resolved = await resolveVoiceSessionConfig({
        cfg: normalizedConfig,
        providerId,
      });
    } catch (error) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          error instanceof Error ? error.message : String(error),
        ),
      );
      return;
    }

    if (!resolved.browser.enabled) {
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

    respond(
      true,
      {
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
      },
      undefined,
    );
  },
};
