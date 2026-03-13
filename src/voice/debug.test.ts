import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const debugState = vi.hoisted(() => ({
  calls: [] as Array<{ message: string; meta?: Record<string, unknown> }>,
}));

vi.mock("../logging/subsystem.js", () => ({
  createSubsystemLogger: () => ({
    info: (message: string, meta?: Record<string, unknown>) => {
      debugState.calls.push({ message, meta });
    },
  }),
}));

describe("voice debug helpers", () => {
  const envSnapshot = new Map<string, string | undefined>();

  beforeEach(() => {
    debugState.calls.length = 0;
    for (const key of ["OPENCLAW_DEBUG_VOICE", "OPENCLAW_DEBUG_VOICE_PAYLOADS"]) {
      envSnapshot.set(key, process.env[key]);
      delete process.env[key];
    }
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
    vi.resetModules();
  });

  it("redacts secrets and summarizes binary payloads", async () => {
    const { sanitizeVoiceDebugPayload, summarizeVoiceDebugPayload } = await import("./debug.js");

    expect(
      sanitizeVoiceDebugPayload({
        apiKey: "secret",
        nested: { token: "abc", ok: true },
        audio: Buffer.from("pcm"),
      }),
    ).toEqual({
      apiKey: "[redacted]",
      nested: { token: "[redacted]", ok: true },
      audio: { type: "buffer", byteLength: 3 },
    });

    expect(
      summarizeVoiceDebugPayload({
        text: "hello",
        items: [{ ok: true }],
      }),
    ).toEqual({
      type: "object",
      keys: ["items", "text"],
    });
  });

  it("requires the master flag before emitting metadata or payload logs", async () => {
    let mod = await import("./debug.js");
    let logger = mod.createVoiceDebugLogger("voice/test");
    logger.debug("metadata", { ok: true });
    logger.payload("payload", { text: "hello" });
    expect(debugState.calls).toEqual([]);

    vi.resetModules();
    process.env.OPENCLAW_DEBUG_VOICE = "1";
    mod = await import("./debug.js");
    logger = mod.createVoiceDebugLogger("voice/test");
    logger.debug("metadata", { ok: true });
    logger.payload("payload", { text: "hello" });
    expect(debugState.calls).toEqual([{ message: "metadata", meta: { ok: true } }]);

    vi.resetModules();
    debugState.calls.length = 0;
    process.env.OPENCLAW_DEBUG_VOICE = "1";
    process.env.OPENCLAW_DEBUG_VOICE_PAYLOADS = "1";
    mod = await import("./debug.js");
    logger = mod.createVoiceDebugLogger("voice/test");
    logger.payload("payload", { text: "hello", apiKey: "secret" }, { state: "test" });
    expect(debugState.calls).toEqual([
      {
        message: "payload",
        meta: {
          state: "test",
          payload: { text: "hello", apiKey: "[redacted]" },
        },
      },
    ]);
  });
});

