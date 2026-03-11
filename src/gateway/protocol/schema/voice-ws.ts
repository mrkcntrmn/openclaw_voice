import { type Static, Type } from "@sinclair/typebox";

export const VoiceWsStartFrameSchema = Type.Object(
  {
    type: Type.Literal("start"),
    ticket: Type.Optional(Type.String()),
    // Compatibility:
    auth: Type.Optional(
      Type.Object(
        {
          token: Type.Optional(Type.String()),
          password: Type.Optional(Type.String()),
        },
        { additionalProperties: false },
      ),
    ),
    sessionKey: Type.Optional(Type.String()),
    provider: Type.Optional(Type.String()),
    modelId: Type.Optional(Type.String()),
    instructions: Type.Optional(Type.String()),
    agentId: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const VoiceWsInterruptFrameSchema = Type.Object(
  {
    type: Type.Literal("interrupt"),
  },
  { additionalProperties: false },
);

export const VoiceWsStopFrameSchema = Type.Object(
  {
    type: Type.Literal("stop"),
  },
  { additionalProperties: false },
);

export const VoiceWsTextFrameSchema = Type.Object(
  {
    type: Type.Literal("text"),
    text: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const VoiceWsPingFrameSchema = Type.Object(
  {
    type: Type.Literal("ping"),
  },
  { additionalProperties: false },
);

export const VoiceWsClientFrameSchema = Type.Union(
  [
    VoiceWsStartFrameSchema,
    VoiceWsInterruptFrameSchema,
    VoiceWsStopFrameSchema,
    VoiceWsTextFrameSchema,
    VoiceWsPingFrameSchema,
  ],
  { discriminator: "type" },
);

export type VoiceWsStartFrame = Static<typeof VoiceWsStartFrameSchema>;
export type VoiceWsInterruptFrame = Static<typeof VoiceWsInterruptFrameSchema>;
export type VoiceWsStopFrame = Static<typeof VoiceWsStopFrameSchema>;
export type VoiceWsTextFrame = Static<typeof VoiceWsTextFrameSchema>;
export type VoiceWsPingFrame = Static<typeof VoiceWsPingFrameSchema>;
export type VoiceWsClientFrame = Static<typeof VoiceWsClientFrameSchema>;


export const VoiceWsReadyFrameSchema = Type.Object(
  {
    type: Type.Literal("ready"),
    sessionKey: Type.Optional(Type.String()),
    provider: Type.Optional(Type.String()),
    modelId: Type.Optional(Type.String()),
    transport: Type.Optional(
      Type.Object(
        {
          sampleRateHz: Type.Optional(Type.Integer()),
          channels: Type.Optional(Type.Integer()),
          frameDurationMs: Type.Optional(Type.Integer()),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);

export const VoiceWsStateFrameSchema = Type.Object(
  {
    type: Type.Literal("state"),
    state: Type.Optional(Type.String()),
    detail: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const VoiceWsTranscriptFrameSchema = Type.Object(
  {
    type: Type.Literal("transcript"),
    role: Type.Optional(Type.String()),
    text: Type.Optional(Type.String()),
    final: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

export const VoiceWsToolCallFrameSchema = Type.Object(
  {
    type: Type.Literal("tool_call"),
    name: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const VoiceWsToolResultFrameSchema = Type.Object(
  {
    type: Type.Literal("tool_result"),
    name: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const VoiceWsErrorFrameSchema = Type.Object(
  {
    type: Type.Literal("error"),
    message: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const VoiceWsPongFrameSchema = Type.Object(
  {
    type: Type.Literal("pong"),
  },
  { additionalProperties: false },
);

export const VoiceWsServerFrameSchema = Type.Union(
  [
    VoiceWsReadyFrameSchema,
    VoiceWsStateFrameSchema,
    VoiceWsTranscriptFrameSchema,
    VoiceWsToolCallFrameSchema,
    VoiceWsToolResultFrameSchema,
    VoiceWsErrorFrameSchema,
    VoiceWsPongFrameSchema,
  ],
  { discriminator: "type" },
);

export type VoiceWsReadyFrame = Static<typeof VoiceWsReadyFrameSchema>;
export type VoiceWsStateFrame = Static<typeof VoiceWsStateFrameSchema>;
export type VoiceWsTranscriptFrame = Static<typeof VoiceWsTranscriptFrameSchema>;
export type VoiceWsToolCallFrame = Static<typeof VoiceWsToolCallFrameSchema>;
export type VoiceWsToolResultFrame = Static<typeof VoiceWsToolResultFrameSchema>;
export type VoiceWsErrorFrame = Static<typeof VoiceWsErrorFrameSchema>;
export type VoiceWsPongFrame = Static<typeof VoiceWsPongFrameSchema>;
export type VoiceWsServerFrame = Static<typeof VoiceWsServerFrameSchema>;
