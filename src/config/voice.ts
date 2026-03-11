import type {
  ResolvedVoiceConfig,
  TalkConfig,
  TalkProviderConfig,
  VoiceConfig,
  VoiceConfigResponse,
  VoiceProviderConfig,
} from "./types.gateway.js";
import type { OpenClawConfig } from "./types.js";
import { coerceSecretRef } from "./types.secrets.js";

export const DEFAULT_VOICE_PROVIDER = "openai-realtime";
export const DEFAULT_VOICE_BROWSER_WS_PATH = "/voice/ws";
export const DEFAULT_VOICE_SAMPLE_RATE_HZ = 16000;
export const DEFAULT_VOICE_FRAME_DURATION_MS = 20;
export const DEFAULT_VOICE_SESSION_KEY_PREFIX = "voice";
export const VOICE_CALL_PLUGIN_CONFIG_DEPRECATED_MESSAGE =
  "plugins.entries.voice-call.config is deprecated for browser voice. Configure top-level voice instead; browser voice ignores voice-call plugin settings.";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizePositiveInteger(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    return undefined;
  }
  return value;
}

function normalizeThreshold(value: unknown): number | undefined {
  if (typeof value !== "number" || Number.isNaN(value) || value < 0 || value > 1) {
    return undefined;
  }
  return value;
}

function normalizeStringRecord(value: unknown): Record<string, string> | undefined {
  if (!isPlainObject(value)) {
    return undefined;
  }
  const normalized: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value)) {
    const normalizedKey = normalizeString(key);
    const normalizedValue = normalizeString(raw);
    if (!normalizedKey || !normalizedValue) {
      continue;
    }
    normalized[normalizedKey] = normalizedValue;
  }
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function normalizeVoiceSecretInput(value: unknown): TalkProviderConfig["apiKey"] | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  return coerceSecretRef(value) ?? undefined;
}

function normalizeVoiceProviderConfig(value: unknown): VoiceProviderConfig | undefined {
  if (!isPlainObject(value)) {
    return undefined;
  }
  const provider: VoiceProviderConfig = {};
  for (const [key, raw] of Object.entries(value)) {
    if (raw === undefined) {
      continue;
    }
    if (key === "voiceAliases" || key === "headers") {
      const normalized = normalizeStringRecord(raw);
      if (normalized) {
        provider[key] = normalized;
      }
      continue;
    }
    if (key === "apiKey") {
      const normalized = normalizeVoiceSecretInput(raw);
      if (normalized !== undefined) {
        provider.apiKey = normalized;
      }
      continue;
    }
    if (
      key === "voiceId" ||
      key === "modelId" ||
      key === "outputFormat" ||
      key === "websocketUrl" ||
      key === "apiVersion" ||
      key === "transcriptionModelId" ||
      key === "inputAudioFormat" ||
      key === "outputAudioFormat"
    ) {
      const normalized = normalizeString(raw);
      if (normalized) {
        provider[key] = normalized;
      }
      continue;
    }
    provider[key] = raw;
  }
  return Object.keys(provider).length > 0 ? provider : undefined;
}

function normalizeVoiceProviders(value: unknown): Record<string, VoiceProviderConfig> | undefined {
  if (!isPlainObject(value)) {
    return undefined;
  }
  const providers: Record<string, VoiceProviderConfig> = {};
  for (const [rawProviderId, providerConfig] of Object.entries(value)) {
    const providerId = normalizeString(rawProviderId);
    const normalizedProvider = normalizeVoiceProviderConfig(providerConfig);
    if (!providerId || !normalizedProvider) {
      continue;
    }
    providers[providerId] = normalizedProvider;
  }
  return Object.keys(providers).length > 0 ? providers : undefined;
}

function normalizeVoiceBrowserConfig(value: unknown): VoiceConfig["browser"] | undefined {
  if (!isPlainObject(value)) {
    return undefined;
  }
  const browser: NonNullable<VoiceConfig["browser"]> = {};
  if (typeof value.enabled === "boolean") {
    browser.enabled = value.enabled;
  }
  const wsPath = normalizeString(value.wsPath);
  if (wsPath) {
    browser.wsPath = wsPath.startsWith("/") ? wsPath : `/${wsPath}`;
  }
  const sampleRateHz = normalizePositiveInteger(value.sampleRateHz);
  if (sampleRateHz !== undefined) {
    browser.sampleRateHz = sampleRateHz;
  }
  const channels = normalizePositiveInteger(value.channels);
  if (channels !== undefined) {
    browser.channels = channels;
  }
  const frameDurationMs = normalizePositiveInteger(value.frameDurationMs);
  if (frameDurationMs !== undefined) {
    browser.frameDurationMs = frameDurationMs;
  }
  if (value.vad === "client" || value.vad === "provider" || value.vad === "server") {
    browser.vad = value.vad;
  }
  const authTimeoutMs = normalizePositiveInteger(value.authTimeoutMs);
  if (authTimeoutMs !== undefined) {
    browser.authTimeoutMs = authTimeoutMs;
  }
  return Object.keys(browser).length > 0 ? browser : undefined;
}

function normalizeVoiceSessionConfig(value: unknown): VoiceConfig["session"] | undefined {
  if (!isPlainObject(value)) {
    return undefined;
  }
  const session: NonNullable<VoiceConfig["session"]> = {};
  if (typeof value.interruptOnSpeech === "boolean") {
    session.interruptOnSpeech = value.interruptOnSpeech;
  }
  if (typeof value.pauseOnToolCall === "boolean") {
    session.pauseOnToolCall = value.pauseOnToolCall;
  }
  if (typeof value.persistTranscripts === "boolean") {
    session.persistTranscripts = value.persistTranscripts;
  }
  if (value.transcriptSource === "provider") {
    session.transcriptSource = "provider";
  }
  const silenceTimeoutMs = normalizePositiveInteger(value.silenceTimeoutMs);
  if (silenceTimeoutMs !== undefined) {
    session.silenceTimeoutMs = silenceTimeoutMs;
  }
  if (typeof value.sharedChatHistory === "boolean") {
    session.sharedChatHistory = value.sharedChatHistory;
  }
  const sessionKeyPrefix = normalizeString(value.sessionKeyPrefix);
  if (sessionKeyPrefix) {
    session.sessionKeyPrefix = sessionKeyPrefix;
  }
  return Object.keys(session).length > 0 ? session : undefined;
}

function normalizeVoiceMessagingConfig(value: unknown): VoiceConfig["messaging"] | undefined {
  if (!isPlainObject(value)) {
    return undefined;
  }
  const messaging: NonNullable<VoiceConfig["messaging"]> = {};
  if (typeof value.enabled === "boolean") {
    messaging.enabled = value.enabled;
  }
  if (isPlainObject(value.ingest)) {
    const ingest: NonNullable<NonNullable<VoiceConfig["messaging"]>["ingest"]> = {};
    if (typeof value.ingest.enabled === "boolean") {
      ingest.enabled = value.ingest.enabled;
    }
    if (Array.isArray(value.ingest.allowedMimes)) {
      const allowedMimes = value.ingest.allowedMimes
        .map((item) => normalizeString(item))
        .filter((item): item is string => Boolean(item));
      if (allowedMimes.length > 0) {
        ingest.allowedMimes = allowedMimes;
      }
    }
    const targetSampleRateHz = normalizePositiveInteger(value.ingest.targetSampleRateHz);
    if (targetSampleRateHz !== undefined) {
      ingest.targetSampleRateHz = targetSampleRateHz;
    }
    if (Object.keys(ingest).length > 0) {
      messaging.ingest = ingest;
    }
  }
  if (isPlainObject(value.walkieTalkie)) {
    const walkieTalkie: NonNullable<NonNullable<VoiceConfig["messaging"]>["walkieTalkie"]> = {};
    if (typeof value.walkieTalkie.enabled === "boolean") {
      walkieTalkie.enabled = value.walkieTalkie.enabled;
    }
    const replyMimeType = normalizeString(value.walkieTalkie.replyMimeType);
    if (replyMimeType) {
      walkieTalkie.replyMimeType = replyMimeType;
    }
    if (typeof value.walkieTalkie.includeTranscript === "boolean") {
      walkieTalkie.includeTranscript = value.walkieTalkie.includeTranscript;
    }
    if (Object.keys(walkieTalkie).length > 0) {
      messaging.walkieTalkie = walkieTalkie;
    }
  }
  return Object.keys(messaging).length > 0 ? messaging : undefined;
}

function normalizeVoiceChannelsConfig(value: unknown): VoiceConfig["channels"] | undefined {
  if (!isPlainObject(value)) {
    return undefined;
  }
  const channels: NonNullable<VoiceConfig["channels"]> = {};
  if (typeof value.enabled === "boolean") {
    channels.enabled = value.enabled;
  }
  if (isPlainObject(value.vad)) {
    const vad: NonNullable<NonNullable<VoiceConfig["channels"]>["vad"]> = {};
    if (typeof value.vad.enabled === "boolean") {
      vad.enabled = value.vad.enabled;
    }
    if (value.vad.provider === "server") {
      vad.provider = "server";
    }
    const library = normalizeString(value.vad.library);
    if (library) {
      vad.library = library;
    }
    const threshold = normalizeThreshold(value.vad.threshold);
    if (threshold !== undefined) {
      vad.threshold = threshold;
    }
    const silenceDurationMs = normalizePositiveInteger(value.vad.silenceDurationMs);
    if (silenceDurationMs !== undefined) {
      vad.silenceDurationMs = silenceDurationMs;
    }
    if (Object.keys(vad).length > 0) {
      channels.vad = vad;
    }
  }
  if (isPlainObject(value.integrations)) {
    const integrations: NonNullable<NonNullable<VoiceConfig["channels"]>["integrations"]> = {};
    for (const provider of ["discord", "telegram"] as const) {
      const integration = value.integrations[provider];
      if (!isPlainObject(integration) || typeof integration.enabled !== "boolean") {
        continue;
      }
      integrations[provider] = { enabled: integration.enabled };
    }
    if (Object.keys(integrations).length > 0) {
      channels.integrations = integrations;
    }
  }
  return Object.keys(channels).length > 0 ? channels : undefined;
}

function normalizeVoiceDeploymentConfig(value: unknown): VoiceConfig["deployment"] | undefined {
  if (!isPlainObject(value)) {
    return undefined;
  }
  const deployment: NonNullable<VoiceConfig["deployment"]> = {};
  if (isPlainObject(value.ffmpeg)) {
    const ffmpeg: NonNullable<NonNullable<VoiceConfig["deployment"]>["ffmpeg"]> = {};
    if (typeof value.ffmpeg.enabled === "boolean") {
      ffmpeg.enabled = value.ffmpeg.enabled;
    }
    const binaryPath = normalizeString(value.ffmpeg.binaryPath);
    if (binaryPath) {
      ffmpeg.binaryPath = binaryPath;
    }
    if (Object.keys(ffmpeg).length > 0) {
      deployment.ffmpeg = ffmpeg;
    }
  }
  if (isPlainObject(value.websocket)) {
    const websocket: NonNullable<NonNullable<VoiceConfig["deployment"]>["websocket"]> = {};
    const maxSessionMinutes = normalizePositiveInteger(value.websocket.maxSessionMinutes);
    if (maxSessionMinutes !== undefined) {
      websocket.maxSessionMinutes = maxSessionMinutes;
    }
    if (Object.keys(websocket).length > 0) {
      deployment.websocket = websocket;
    }
  }
  return Object.keys(deployment).length > 0 ? deployment : undefined;
}

function mergeDefined<T>(primary: T | undefined, fallback: T | undefined): T | undefined {
  if (primary === undefined) {
    return fallback;
  }
  if (fallback === undefined) {
    return primary;
  }
  if (!isPlainObject(primary) || !isPlainObject(fallback)) {
    return primary;
  }
  const merged: Record<string, unknown> = { ...fallback };
  for (const [key, value] of Object.entries(primary)) {
    const fallbackValue = (fallback as Record<string, unknown>)[key];
    merged[key] = mergeDefined(value, fallbackValue);
  }
  return merged as T;
}

function mergeVoiceProviderMaps(
  primary: Record<string, VoiceProviderConfig> | undefined,
  fallback: Record<string, VoiceProviderConfig> | undefined,
): Record<string, VoiceProviderConfig> | undefined {
  if (!primary) {
    return fallback ? { ...fallback } : undefined;
  }
  if (!fallback) {
    return { ...primary };
  }
  const merged: Record<string, VoiceProviderConfig> = {};
  for (const providerId of new Set([...Object.keys(fallback), ...Object.keys(primary)])) {
    merged[providerId] = mergeDefined(primary[providerId], fallback[providerId]) ?? {};
  }
  return Object.keys(merged).length > 0 ? merged : undefined;
}

function mergeVoiceConfigs(
  primary: VoiceConfig | undefined,
  fallback: VoiceConfig | undefined,
): VoiceConfig | undefined {
  if (!primary) {
    return fallback ? { ...fallback } : undefined;
  }
  if (!fallback) {
    return { ...primary };
  }
  return normalizeVoiceSection({
    provider: primary.provider ?? fallback.provider,
    providers: mergeVoiceProviderMaps(primary.providers, fallback.providers),
    browser: mergeDefined(primary.browser, fallback.browser),
    session: mergeDefined(primary.session, fallback.session),
    messaging: mergeDefined(primary.messaging, fallback.messaging),
    channels: mergeDefined(primary.channels, fallback.channels),
    deployment: mergeDefined(primary.deployment, fallback.deployment),
  });
}

function toTalkProviderConfig(provider: VoiceProviderConfig | undefined): TalkProviderConfig | undefined {
  if (!provider) {
    return undefined;
  }
  const talkProvider: TalkProviderConfig = {};
  if (typeof provider.voiceId === "string") {
    talkProvider.voiceId = provider.voiceId;
  }
  if (provider.voiceAliases) {
    talkProvider.voiceAliases = provider.voiceAliases;
  }
  if (typeof provider.modelId === "string") {
    talkProvider.modelId = provider.modelId;
  }
  if (typeof provider.outputFormat === "string") {
    talkProvider.outputFormat = provider.outputFormat;
  }
  if (provider.apiKey !== undefined) {
    talkProvider.apiKey = provider.apiKey;
  }
  return Object.keys(talkProvider).length > 0 ? talkProvider : undefined;
}

function legacyTalkFieldsFromVoiceProvider(provider: VoiceProviderConfig | undefined): Partial<TalkConfig> {
  const talkProvider = toTalkProviderConfig(provider);
  if (!talkProvider) {
    return {};
  }
  return {
    ...(talkProvider.voiceId ? { voiceId: talkProvider.voiceId } : {}),
    ...(talkProvider.voiceAliases ? { voiceAliases: talkProvider.voiceAliases } : {}),
    ...(talkProvider.modelId ? { modelId: talkProvider.modelId } : {}),
    ...(talkProvider.outputFormat ? { outputFormat: talkProvider.outputFormat } : {}),
    ...(talkProvider.apiKey !== undefined ? { apiKey: talkProvider.apiKey } : {}),
  };
}

export function normalizeVoiceSection(
  value: VoiceConfig | undefined,
  fallbackProvider = DEFAULT_VOICE_PROVIDER,
): VoiceConfig | undefined {
  if (!isPlainObject(value)) {
    return undefined;
  }

  const source = value as Record<string, unknown>;
  const normalized: VoiceConfig = {};
  const browser = normalizeVoiceBrowserConfig(source.browser);
  if (browser) {
    normalized.browser = browser;
  }
  const session = normalizeVoiceSessionConfig(source.session);
  if (session) {
    normalized.session = session;
  }
  const messaging = normalizeVoiceMessagingConfig(source.messaging);
  if (messaging) {
    normalized.messaging = messaging;
  }
  const channels = normalizeVoiceChannelsConfig(source.channels);
  if (channels) {
    normalized.channels = channels;
  }
  const deployment = normalizeVoiceDeploymentConfig(source.deployment);
  if (deployment) {
    normalized.deployment = deployment;
  }

  const provider = normalizeString(source.provider);
  let providers = normalizeVoiceProviders(source.providers);
  const legacyProvider = normalizeVoiceProviderConfig({
    voiceId: source.voiceId,
    voiceAliases: source.voiceAliases,
    modelId: source.modelId,
    outputFormat: source.outputFormat,
    apiKey: source.apiKey,
    websocketUrl: source.websocketUrl,
    apiVersion: source.apiVersion,
    transcriptionModelId: source.transcriptionModelId,
    inputAudioFormat: source.inputAudioFormat,
    outputAudioFormat: source.outputAudioFormat,
    headers: source.headers,
  });

  const providerId = provider ?? (providers && Object.keys(providers).length === 1 ? Object.keys(providers)[0] : undefined);
  if (providerId && legacyProvider) {
    providers = {
      ...(providers ?? {}),
      [providerId]: mergeDefined(providers?.[providerId], legacyProvider) ?? legacyProvider,
    };
  }
  if (providers) {
    normalized.providers = providers;
  }
  if (providerId) {
    normalized.provider = providerId;
  } else if (!providers && legacyProvider) {
    normalized.provider = fallbackProvider;
    normalized.providers = { [fallbackProvider]: legacyProvider };
  }

  return Object.keys(normalized).length > 0 ? normalized : undefined;
}
export function resolveActiveVoiceProviderConfig(
  voice: VoiceConfig | undefined,
): ResolvedVoiceConfig | undefined {
  const normalized = normalizeVoiceSection(voice);
  if (!normalized) {
    return undefined;
  }
  const providerId = normalizeString(normalized.provider);
  if (providerId && normalized.providers?.[providerId]) {
    return {
      provider: providerId,
      config: normalized.providers[providerId],
    };
  }
  const providerIds = normalized.providers ? Object.keys(normalized.providers) : [];
  if (providerIds.length !== 1) {
    return undefined;
  }
  return {
    provider: providerIds[0],
    config: normalized.providers?.[providerIds[0]] ?? {},
  };
}

export function buildTalkInputFromVoiceConfig(value: VoiceConfig | undefined): TalkConfig | undefined {
  const normalized = normalizeVoiceSection(value);
  if (!normalized) {
    return undefined;
  }
  const talkProviders = normalized.providers
    ? Object.fromEntries(
        Object.entries(normalized.providers)
          .map(([providerId, provider]) => [providerId, toTalkProviderConfig(provider)])
          .filter((entry): entry is [string, TalkProviderConfig] => Boolean(entry[1])),
      )
    : undefined;
  const resolved = resolveActiveVoiceProviderConfig(normalized);
  const talk: TalkConfig = {};
  if (typeof normalized.provider === "string") {
    talk.provider = normalized.provider;
  }
  if (talkProviders && Object.keys(talkProviders).length > 0) {
    talk.providers = talkProviders;
  }
  if (typeof normalized.session?.interruptOnSpeech === "boolean") {
    talk.interruptOnSpeech = normalized.session.interruptOnSpeech;
  }
  if (typeof normalized.session?.silenceTimeoutMs === "number") {
    talk.silenceTimeoutMs = normalized.session.silenceTimeoutMs;
  }
  Object.assign(talk, legacyTalkFieldsFromVoiceProvider(resolved?.config));
  return Object.keys(talk).length > 0 ? talk : undefined;
}

function buildVoiceConfigFromTalk(talk: TalkConfig | undefined): VoiceConfig | undefined {
  if (!talk) {
    return undefined;
  }
  return normalizeVoiceSection({
    provider: talk.provider,
    providers: talk.providers ? Object.fromEntries(Object.entries(talk.providers).map(([providerId, provider]) => [providerId, { ...provider }])) : undefined,
    browser: {
      wsPath: DEFAULT_VOICE_BROWSER_WS_PATH,
      sampleRateHz: DEFAULT_VOICE_SAMPLE_RATE_HZ,
      channels: 1,
      frameDurationMs: DEFAULT_VOICE_FRAME_DURATION_MS,
      vad: "provider",
    },
    session: {
      interruptOnSpeech: talk.interruptOnSpeech,
      silenceTimeoutMs: talk.silenceTimeoutMs,
      persistTranscripts: true,
      sharedChatHistory: true,
      transcriptSource: "provider",
      sessionKeyPrefix: DEFAULT_VOICE_SESSION_KEY_PREFIX,
    },
  }, talk.provider ?? DEFAULT_VOICE_PROVIDER);
}

function hasDeprecatedVoiceCallPluginConfig(
  config: Pick<OpenClawConfig, "plugins">,
): boolean {
  return isPlainObject(config.plugins?.entries?.["voice-call"]?.config);
}

export function listVoiceConfigDeprecations(
  config: Pick<OpenClawConfig, "plugins">,
): string[] {
  return hasDeprecatedVoiceCallPluginConfig(config)
    ? [VOICE_CALL_PLUGIN_CONFIG_DEPRECATED_MESSAGE]
    : [];
}

export function normalizeVoiceConfig(config: OpenClawConfig): OpenClawConfig {
  const mergedVoice = mergeVoiceConfigs(
    normalizeVoiceSection(config.voice),
    buildVoiceConfigFromTalk(config.talk),
  );
  if (!mergedVoice) {
    return config;
  }
  return {
    ...config,
    voice: mergedVoice,
  };
}

export function buildVoiceConfigResponseFromConfig(
  config: Pick<OpenClawConfig, "voice" | "talk" | "plugins">,
): VoiceConfigResponse | undefined {
  const normalized = mergeVoiceConfigs(
    normalizeVoiceSection(config.voice),
    buildVoiceConfigFromTalk(config.talk),
  );
  const deprecations = listVoiceConfigDeprecations(config);
  const response = buildVoiceConfigResponse(normalized);
  if (!response) {
    return deprecations.length > 0 ? { deprecations } : undefined;
  }
  return deprecations.length > 0 ? { ...response, deprecations } : response;
}

export function buildVoiceConfigResponse(value: unknown): VoiceConfigResponse | undefined {
  if (!isPlainObject(value)) {
    return undefined;
  }
  const normalized = normalizeVoiceSection(value as VoiceConfig);
  if (!normalized) {
    return undefined;
  }
  const resolved = resolveActiveVoiceProviderConfig(normalized);
  return {
    ...normalized,
    ...(resolved ? { resolved } : {}),
  };
}
