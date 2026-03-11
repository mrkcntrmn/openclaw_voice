import type { ErrorObject } from "ajv";
import { describe, expect, it } from "vitest";
import {
  formatValidationErrors,
  validateTalkConfigResult,
  validateVoiceConfigResult,
  validateVoiceSessionCreateResult,
} from "./index.js";

const makeError = (overrides: Partial<ErrorObject>): ErrorObject => ({
  keyword: "type",
  instancePath: "",
  schemaPath: "#/",
  params: {},
  message: "validation error",
  ...overrides,
});

describe("formatValidationErrors", () => {
  it("returns unknown validation error when missing errors", () => {
    expect(formatValidationErrors(undefined)).toBe("unknown validation error");
    expect(formatValidationErrors(null)).toBe("unknown validation error");
  });

  it("returns unknown validation error when errors list is empty", () => {
    expect(formatValidationErrors([])).toBe("unknown validation error");
  });

  it("formats additionalProperties at root", () => {
    const err = makeError({
      keyword: "additionalProperties",
      params: { additionalProperty: "token" },
    });

    expect(formatValidationErrors([err])).toBe("at root: unexpected property 'token'");
  });

  it("formats additionalProperties with instancePath", () => {
    const err = makeError({
      keyword: "additionalProperties",
      instancePath: "/auth",
      params: { additionalProperty: "token" },
    });

    expect(formatValidationErrors([err])).toBe("at /auth: unexpected property 'token'");
  });

  it("formats message with path for other errors", () => {
    const err = makeError({
      keyword: "required",
      instancePath: "/auth",
      message: "must have required property 'token'",
    });

    expect(formatValidationErrors([err])).toBe("at /auth: must have required property 'token'");
  });

  it("de-dupes repeated entries", () => {
    const err = makeError({
      keyword: "required",
      instancePath: "/auth",
      message: "must have required property 'token'",
    });

    expect(formatValidationErrors([err, err])).toBe(
      "at /auth: must have required property 'token'",
    );
  });
});

describe("validateTalkConfigResult", () => {
  it("accepts Talk SecretRef payloads", () => {
    expect(
      validateTalkConfigResult({
        config: {
          talk: {
            provider: "elevenlabs",
            providers: {
              elevenlabs: {
                apiKey: {
                  source: "env",
                  provider: "default",
                  id: "ELEVENLABS_API_KEY",
                },
              },
            },
            resolved: {
              provider: "elevenlabs",
              config: {
                apiKey: {
                  source: "env",
                  provider: "default",
                  id: "ELEVENLABS_API_KEY",
                },
              },
            },
            apiKey: {
              source: "env",
              provider: "default",
              id: "ELEVENLABS_API_KEY",
            },
          },
        },
      }),
    ).toBe(true);
  });

  it("rejects normalized talk payloads without talk.resolved", () => {
    expect(
      validateTalkConfigResult({
        config: {
          talk: {
            provider: "elevenlabs",
            providers: {
              elevenlabs: {
                voiceId: "voice-normalized",
              },
            },
          },
        },
      }),
    ).toBe(false);
  });
});

describe("voice protocol validators", () => {
  it("accepts deprecations-only voice.config payloads", () => {
    expect(
      validateVoiceConfigResult({
        config: {
          voice: {
            deprecations: ["legacy voice-call config is deprecated"],
          },
        },
      }),
    ).toBe(true);
  });

  it("accepts voice.session.create bootstrap payloads", () => {
    expect(
      validateVoiceSessionCreateResult({
        ticket: "ticket-123",
        expiresAt: 1_234,
        sessionKey: "voice:browser:test",
        provider: "openai-realtime",
        modelId: "gpt-4o-realtime-preview",
        transport: {
          wsPath: "/voice/ws",
          sampleRateHz: 16_000,
          channels: 1,
          frameDurationMs: 20,
        },
        session: {
          interruptOnSpeech: true,
          pauseOnToolCall: true,
          persistTranscripts: true,
          transcriptSource: "provider",
          sharedChatHistory: true,
          sessionKeyPrefix: "voice",
        },
      }),
    ).toBe(true);
  });
});
