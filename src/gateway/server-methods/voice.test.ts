import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const debugState = vi.hoisted(() => ({
  debugCalls: [] as Array<{ subsystem: string; message: string; meta?: Record<string, unknown> }>,
  payloadCalls: [] as Array<{
    subsystem: string;
    message: string;
    payload: unknown;
    meta?: Record<string, unknown>;
  }>,
}));

const methodState = vi.hoisted(() => ({
  readConfigFileSnapshot: vi.fn(),
  resolveVoiceSessionConfig: vi.fn(),
  issueTicket: vi.fn(),
}));

vi.mock("../../voice/debug.js", () => ({
  createVoiceDebugLogger: (subsystem: string) => ({
    debug: (message: string, meta?: Record<string, unknown>) => {
      if (process.env.OPENCLAW_DEBUG_VOICE === "1") {
        debugState.debugCalls.push({ subsystem, message, meta });
      }
    },
    payload: (message: string, payload: unknown, meta?: Record<string, unknown>) => {
      if (
        process.env.OPENCLAW_DEBUG_VOICE === "1" &&
        process.env.OPENCLAW_DEBUG_VOICE_PAYLOADS === "1"
      ) {
        debugState.payloadCalls.push({ subsystem, message, payload, meta });
      }
    },
  }),
  summarizeVoiceDebugPayload: (value: unknown) => value,
  voiceDebugElapsedMs: () => 3,
}));

vi.mock("../../config/config.js", () => ({
  readConfigFileSnapshot: (...args: unknown[]) => methodState.readConfigFileSnapshot(...args),
}));

vi.mock("../../config/redact-snapshot.js", () => ({
  redactConfigObject: (value: unknown) => value,
}));

vi.mock("../../config/voice.js", () => ({
  buildVoiceConfigResponseFromConfig: () => ({
    provider: "openai-realtime",
    browser: { enabled: true },
    deprecations: ["legacy warning"],
  }),
  listVoiceConfigDeprecations: () => ["legacy warning"],
  normalizeVoiceConfig: (value: unknown) => value,
}));

vi.mock("../../voice/runtime.js", () => ({
  resolveVoiceSessionConfig: (...args: unknown[]) => methodState.resolveVoiceSessionConfig(...args),
}));

import { voiceHandlers } from "./voice.js";

describe("voice handler debug logging", () => {
  const envSnapshot = new Map<string, string | undefined>();

  beforeEach(() => {
    debugState.debugCalls.length = 0;
    debugState.payloadCalls.length = 0;
    methodState.readConfigFileSnapshot.mockReset();
    methodState.resolveVoiceSessionConfig.mockReset();
    methodState.issueTicket.mockReset();
    for (const key of ["OPENCLAW_DEBUG_VOICE", "OPENCLAW_DEBUG_VOICE_PAYLOADS"]) {
      envSnapshot.set(key, process.env[key]);
      delete process.env[key];
    }
    methodState.readConfigFileSnapshot.mockResolvedValue({ config: { session: { mainKey: "main" } } });
    methodState.resolveVoiceSessionConfig.mockResolvedValue({
      voice: { provider: "openai-realtime" },
      providerId: "openai-realtime",
      provider: { apiKey: "secret" },
      modelId: "gpt-4o-realtime-preview",
      browser: {
        enabled: true,
        wsPath: "/voice/ws",
        sampleRateHz: 16000,
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
    });
    methodState.issueTicket.mockReturnValue({
      ticket: "voice-ticket",
      expiresAt: "2026-03-11T20:00:00.000Z",
    });
  });

  afterEach(() => {
    for (const [key, value] of envSnapshot) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    envSnapshot.clear();
  });

  it("logs voice.config metadata and only emits payload logs when payload mode is enabled", async () => {
    process.env.OPENCLAW_DEBUG_VOICE = "1";
    const respond = vi.fn();

    await voiceHandlers["voice.config"]({
      params: {},
      respond: respond as never,
      client: { connect: { scopes: ["operator.read"] } } as never,
      context: {} as never,
      req: {} as never,
      isWebchatConnect: (() => false) as never,
    });

    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ config: expect.any(Object) }),
      undefined,
    );
    expect(debugState.debugCalls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ subsystem: "gateway/voice", message: "voice config request" }),
        expect.objectContaining({ subsystem: "gateway/voice", message: "voice config response" }),
      ]),
    );
    expect(debugState.payloadCalls).toEqual([]);

    process.env.OPENCLAW_DEBUG_VOICE_PAYLOADS = "1";
    await voiceHandlers["voice.config"]({
      params: {},
      respond: respond as never,
      client: { connect: { scopes: ["operator.read"] } } as never,
      context: {} as never,
      req: {} as never,
      isWebchatConnect: (() => false) as never,
    });

    expect(debugState.payloadCalls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ subsystem: "gateway/voice", message: "voice config request payload" }),
        expect.objectContaining({ subsystem: "gateway/voice", message: "voice config response payload" }),
      ]),
    );
  });

  it("logs bootstrap success and failure reasons", async () => {
    process.env.OPENCLAW_DEBUG_VOICE = "1";
    process.env.OPENCLAW_DEBUG_VOICE_PAYLOADS = "1";
    const respond = vi.fn();

    await voiceHandlers["voice.session.create"]({
      params: { sessionKey: "voice:test", provider: "openai-realtime" },
      respond: respond as never,
      client: { connect: { scopes: ["operator.read"] } } as never,
      context: {
        voiceSessionTickets: {
          issue: methodState.issueTicket,
        },
      } as never,
      req: {} as never,
      isWebchatConnect: (() => false) as never,
    });

    expect(methodState.issueTicket).toHaveBeenCalledTimes(1);
    expect(debugState.debugCalls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ subsystem: "gateway/voice", message: "voice bootstrap request" }),
        expect.objectContaining({
          subsystem: "gateway/voice",
          message: "voice bootstrap response",
          meta: expect.objectContaining({ ok: true, sessionKey: "voice:test", providerId: "openai-realtime" }),
        }),
      ]),
    );
    expect(debugState.payloadCalls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ subsystem: "gateway/voice", message: "voice bootstrap request payload" }),
        expect.objectContaining({ subsystem: "gateway/voice", message: "voice bootstrap response payload" }),
      ]),
    );

    debugState.debugCalls.length = 0;
    methodState.resolveVoiceSessionConfig.mockRejectedValueOnce(new Error("provider unavailable"));

    await voiceHandlers["voice.session.create"]({
      params: { sessionKey: "voice:test" },
      respond: respond as never,
      client: { connect: { scopes: ["operator.read"] } } as never,
      context: {
        voiceSessionTickets: {
          issue: methodState.issueTicket,
        },
      } as never,
      req: {} as never,
      isWebchatConnect: (() => false) as never,
    });

    expect(debugState.debugCalls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          subsystem: "gateway/voice",
          message: "voice bootstrap response",
          meta: expect.objectContaining({ ok: false, reason: "resolve-config", error: "provider unavailable" }),
        }),
      ]),
    );
  });
});
