import { Type } from "@sinclair/typebox";
import { NonEmptyString, SecretInputSchema } from "./primitives.js";

export const TalkModeParamsSchema = Type.Object(
  {
    enabled: Type.Boolean(),
    phase: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const TalkConfigParamsSchema = Type.Object(
  {
    includeSecrets: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

const TalkProviderConfigSchema = Type.Object(
  {
    voiceId: Type.Optional(Type.String()),
    voiceAliases: Type.Optional(Type.Record(Type.String(), Type.String())),
    modelId: Type.Optional(Type.String()),
    outputFormat: Type.Optional(Type.String()),
    apiKey: Type.Optional(SecretInputSchema),
  },
  { additionalProperties: true },
);

const ResolvedTalkConfigSchema = Type.Object(
  {
    provider: Type.String(),
    config: TalkProviderConfigSchema,
  },
  { additionalProperties: false },
);

const LegacyTalkConfigSchema = Type.Object(
  {
    voiceId: Type.Optional(Type.String()),
    voiceAliases: Type.Optional(Type.Record(Type.String(), Type.String())),
    modelId: Type.Optional(Type.String()),
    outputFormat: Type.Optional(Type.String()),
    apiKey: Type.Optional(SecretInputSchema),
    interruptOnSpeech: Type.Optional(Type.Boolean()),
    silenceTimeoutMs: Type.Optional(Type.Integer({ minimum: 1 })),
  },
  { additionalProperties: false },
);

const NormalizedTalkConfigSchema = Type.Object(
  {
    provider: Type.Optional(Type.String()),
    providers: Type.Optional(Type.Record(Type.String(), TalkProviderConfigSchema)),
    resolved: ResolvedTalkConfigSchema,
    voiceId: Type.Optional(Type.String()),
    voiceAliases: Type.Optional(Type.Record(Type.String(), Type.String())),
    modelId: Type.Optional(Type.String()),
    outputFormat: Type.Optional(Type.String()),
    apiKey: Type.Optional(SecretInputSchema),
    interruptOnSpeech: Type.Optional(Type.Boolean()),
    silenceTimeoutMs: Type.Optional(Type.Integer({ minimum: 1 })),
  },
  { additionalProperties: false },
);

export const TalkConfigResultSchema = Type.Object(
  {
    config: Type.Object(
      {
        talk: Type.Optional(Type.Union([LegacyTalkConfigSchema, NormalizedTalkConfigSchema])),
        session: Type.Optional(
          Type.Object(
            {
              mainKey: Type.Optional(Type.String()),
            },
            { additionalProperties: false },
          ),
        ),
        ui: Type.Optional(
          Type.Object(
            {
              seamColor: Type.Optional(Type.String()),
            },
            { additionalProperties: false },
          ),
        ),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export const VoiceConfigParamsSchema = Type.Object(
  {
    includeSecrets: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

const VoiceProviderConfigSchema = Type.Object(
  {
    voiceId: Type.Optional(Type.String()),
    voiceAliases: Type.Optional(Type.Record(Type.String(), Type.String())),
    modelId: Type.Optional(Type.String()),
    outputFormat: Type.Optional(Type.String()),
    apiKey: Type.Optional(SecretInputSchema),
    websocketUrl: Type.Optional(Type.String()),
    apiVersion: Type.Optional(Type.String()),
    transcriptionModelId: Type.Optional(Type.String()),
    inputAudioFormat: Type.Optional(Type.String()),
    outputAudioFormat: Type.Optional(Type.String()),
    headers: Type.Optional(Type.Record(Type.String(), Type.String())),
  },
  { additionalProperties: true },
);

const ResolvedVoiceConfigSchema = Type.Object(
  {
    provider: Type.String(),
    config: VoiceProviderConfigSchema,
  },
  { additionalProperties: false },
);

const VoiceBrowserConfigSchema = Type.Object(
  {
    enabled: Type.Optional(Type.Boolean()),
    wsPath: Type.Optional(Type.String()),
    sampleRateHz: Type.Optional(Type.Integer({ minimum: 1 })),
    channels: Type.Optional(Type.Integer({ minimum: 1 })),
    frameDurationMs: Type.Optional(Type.Integer({ minimum: 1 })),
    vad: Type.Optional(Type.Union([Type.Literal("client"), Type.Literal("provider"), Type.Literal("server")])),
    authTimeoutMs: Type.Optional(Type.Integer({ minimum: 1 })),
  },
  { additionalProperties: false },
);

const VoiceSessionConfigSchema = Type.Object(
  {
    interruptOnSpeech: Type.Optional(Type.Boolean()),
    pauseOnToolCall: Type.Optional(Type.Boolean()),
    persistTranscripts: Type.Optional(Type.Boolean()),
    transcriptSource: Type.Optional(Type.Literal("provider")),
    silenceTimeoutMs: Type.Optional(Type.Integer({ minimum: 1 })),
    sharedChatHistory: Type.Optional(Type.Boolean()),
    sessionKeyPrefix: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

const VoiceMessagingConfigSchema = Type.Object(
  {
    enabled: Type.Optional(Type.Boolean()),
    ingest: Type.Optional(
      Type.Object(
        {
          enabled: Type.Optional(Type.Boolean()),
          allowedMimes: Type.Optional(Type.Array(Type.String())),
          targetSampleRateHz: Type.Optional(Type.Integer({ minimum: 1 })),
        },
        { additionalProperties: false },
      ),
    ),
    walkieTalkie: Type.Optional(
      Type.Object(
        {
          enabled: Type.Optional(Type.Boolean()),
          replyMimeType: Type.Optional(Type.String()),
          includeTranscript: Type.Optional(Type.Boolean()),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);

const VoicePersistentChannelsConfigSchema = Type.Object(
  {
    enabled: Type.Optional(Type.Boolean()),
    vad: Type.Optional(
      Type.Object(
        {
          enabled: Type.Optional(Type.Boolean()),
          provider: Type.Optional(Type.Literal("server")),
          library: Type.Optional(Type.String()),
          threshold: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
          silenceDurationMs: Type.Optional(Type.Integer({ minimum: 1 })),
        },
        { additionalProperties: false },
      ),
    ),
    integrations: Type.Optional(
      Type.Object(
        {
          discord: Type.Optional(
            Type.Object(
              {
                enabled: Type.Optional(Type.Boolean()),
              },
              { additionalProperties: false },
            ),
          ),
          telegram: Type.Optional(
            Type.Object(
              {
                enabled: Type.Optional(Type.Boolean()),
              },
              { additionalProperties: false },
            ),
          ),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);

const VoiceDeploymentConfigSchema = Type.Object(
  {
    ffmpeg: Type.Optional(
      Type.Object(
        {
          enabled: Type.Optional(Type.Boolean()),
          binaryPath: Type.Optional(Type.String()),
        },
        { additionalProperties: false },
      ),
    ),
    websocket: Type.Optional(
      Type.Object(
        {
          maxSessionMinutes: Type.Optional(Type.Integer({ minimum: 1 })),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);

const VoiceConfigResponseSchema = Type.Object(
  {
    provider: Type.Optional(Type.String()),
    providers: Type.Optional(Type.Record(Type.String(), VoiceProviderConfigSchema)),
    browser: Type.Optional(VoiceBrowserConfigSchema),
    session: Type.Optional(VoiceSessionConfigSchema),
    messaging: Type.Optional(VoiceMessagingConfigSchema),
    channels: Type.Optional(VoicePersistentChannelsConfigSchema),
    deployment: Type.Optional(VoiceDeploymentConfigSchema),
    resolved: Type.Optional(ResolvedVoiceConfigSchema),
    deprecations: Type.Optional(Type.Array(Type.String())),
  },
  { additionalProperties: false },
);

export const VoiceConfigResultSchema = Type.Object(
  {
    config: Type.Object(
      {
        voice: Type.Optional(VoiceConfigResponseSchema),
        session: Type.Optional(
          Type.Object(
            {
              mainKey: Type.Optional(Type.String()),
            },
            { additionalProperties: false },
          ),
        ),
        ui: Type.Optional(
          Type.Object(
            {
              seamColor: Type.Optional(Type.String()),
            },
            { additionalProperties: false },
          ),
        ),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export const VoiceSessionCreateParamsSchema = Type.Object(
  {
    provider: Type.Optional(Type.String()),
    modelId: Type.Optional(Type.String()),
    sessionKey: Type.Optional(Type.String()),
    agentId: Type.Optional(Type.String()),
    instructions: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

const VoiceSessionTransportSchema = Type.Object(
  {
    wsPath: Type.String(),
    sampleRateHz: Type.Integer({ minimum: 1 }),
    channels: Type.Integer({ minimum: 1 }),
    frameDurationMs: Type.Integer({ minimum: 1 }),
  },
  { additionalProperties: false },
);

const VoiceResolvedSessionSchema = Type.Object(
  {
    interruptOnSpeech: Type.Boolean(),
    pauseOnToolCall: Type.Boolean(),
    persistTranscripts: Type.Boolean(),
    transcriptSource: Type.Literal("provider"),
    silenceTimeoutMs: Type.Optional(Type.Integer({ minimum: 1 })),
    sharedChatHistory: Type.Boolean(),
    sessionKeyPrefix: Type.String(),
  },
  { additionalProperties: false },
);

export const VoiceSessionCreateResultSchema = Type.Object(
  {
    ticket: Type.String(),
    expiresAt: Type.Integer({ minimum: 0 }),
    sessionKey: Type.String(),
    provider: Type.String(),
    modelId: Type.String(),
    transport: VoiceSessionTransportSchema,
    session: VoiceResolvedSessionSchema,
    deprecations: Type.Optional(Type.Array(Type.String())),
  },
  { additionalProperties: false },
);

export const ChannelsStatusParamsSchema = Type.Object(
  {
    probe: Type.Optional(Type.Boolean()),
    timeoutMs: Type.Optional(Type.Integer({ minimum: 0 })),
  },
  { additionalProperties: false },
);

// Channel docking: channels.status is intentionally schema-light so new
// channels can ship without protocol updates.
export const ChannelAccountSnapshotSchema = Type.Object(
  {
    accountId: NonEmptyString,
    name: Type.Optional(Type.String()),
    enabled: Type.Optional(Type.Boolean()),
    configured: Type.Optional(Type.Boolean()),
    linked: Type.Optional(Type.Boolean()),
    running: Type.Optional(Type.Boolean()),
    connected: Type.Optional(Type.Boolean()),
    reconnectAttempts: Type.Optional(Type.Integer({ minimum: 0 })),
    lastConnectedAt: Type.Optional(Type.Integer({ minimum: 0 })),
    lastError: Type.Optional(Type.String()),
    lastStartAt: Type.Optional(Type.Integer({ minimum: 0 })),
    lastStopAt: Type.Optional(Type.Integer({ minimum: 0 })),
    lastInboundAt: Type.Optional(Type.Integer({ minimum: 0 })),
    lastOutboundAt: Type.Optional(Type.Integer({ minimum: 0 })),
    busy: Type.Optional(Type.Boolean()),
    activeRuns: Type.Optional(Type.Integer({ minimum: 0 })),
    lastRunActivityAt: Type.Optional(Type.Integer({ minimum: 0 })),
    lastProbeAt: Type.Optional(Type.Integer({ minimum: 0 })),
    mode: Type.Optional(Type.String()),
    dmPolicy: Type.Optional(Type.String()),
    allowFrom: Type.Optional(Type.Array(Type.String())),
    tokenSource: Type.Optional(Type.String()),
    botTokenSource: Type.Optional(Type.String()),
    appTokenSource: Type.Optional(Type.String()),
    baseUrl: Type.Optional(Type.String()),
    allowUnmentionedGroups: Type.Optional(Type.Boolean()),
    cliPath: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    dbPath: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    port: Type.Optional(Type.Union([Type.Integer({ minimum: 0 }), Type.Null()])),
    probe: Type.Optional(Type.Unknown()),
    audit: Type.Optional(Type.Unknown()),
    application: Type.Optional(Type.Unknown()),
  },
  { additionalProperties: true },
);

export const ChannelUiMetaSchema = Type.Object(
  {
    id: NonEmptyString,
    label: NonEmptyString,
    detailLabel: NonEmptyString,
    systemImage: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const ChannelsStatusResultSchema = Type.Object(
  {
    ts: Type.Integer({ minimum: 0 }),
    channelOrder: Type.Array(NonEmptyString),
    channelLabels: Type.Record(NonEmptyString, NonEmptyString),
    channelDetailLabels: Type.Optional(Type.Record(NonEmptyString, NonEmptyString)),
    channelSystemImages: Type.Optional(Type.Record(NonEmptyString, NonEmptyString)),
    channelMeta: Type.Optional(Type.Array(ChannelUiMetaSchema)),
    channels: Type.Record(NonEmptyString, Type.Unknown()),
    channelAccounts: Type.Record(NonEmptyString, Type.Array(ChannelAccountSnapshotSchema)),
    channelDefaultAccountId: Type.Record(NonEmptyString, NonEmptyString),
  },
  { additionalProperties: false },
);

export const ChannelsLogoutParamsSchema = Type.Object(
  {
    channel: NonEmptyString,
    accountId: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const WebLoginStartParamsSchema = Type.Object(
  {
    force: Type.Optional(Type.Boolean()),
    timeoutMs: Type.Optional(Type.Integer({ minimum: 0 })),
    verbose: Type.Optional(Type.Boolean()),
    accountId: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const WebLoginWaitParamsSchema = Type.Object(
  {
    timeoutMs: Type.Optional(Type.Integer({ minimum: 0 })),
    accountId: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);
