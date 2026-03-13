import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerLogTransport, resetLogger, setLoggerOverride } from "../logging/logger.js";

function tempLogPath(): string {
  return path.join(os.tmpdir(), `openclaw-voice-debug-${Date.now()}-${Math.random().toString(16).slice(2)}.log`);
}

describe("createVoiceDebugLogger with real logger", () => {
  const envSnapshot = new Map<string, string | undefined>();
  let unregisterTransport: (() => void) | undefined;

  beforeEach(() => {
    for (const key of ["OPENCLAW_DEBUG_VOICE", "OPENCLAW_DEBUG_VOICE_PAYLOADS"]) {
      envSnapshot.set(key, process.env[key]);
      delete process.env[key];
    }
    unregisterTransport = undefined;
    setLoggerOverride(null);
    resetLogger();
  });

  afterEach(() => {
    unregisterTransport?.();
    unregisterTransport = undefined;
    for (const [key, value] of envSnapshot) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    envSnapshot.clear();
    setLoggerOverride(null);
    resetLogger();
  });

  it("emits metadata logs at the default info file threshold", async () => {
    process.env.OPENCLAW_DEBUG_VOICE = "1";
    const logPath = tempLogPath();
    const records: Array<Record<string, unknown>> = [];
    setLoggerOverride({
      level: "info",
      consoleLevel: "silent",
      file: logPath,
    });
    unregisterTransport = registerLogTransport((record) => {
      records.push(record);
    });

    const { createVoiceDebugLogger } = await import("./debug.js");
    const logger = createVoiceDebugLogger("gateway/voice");
    logger.debug("voice bootstrap request", {
      providerId: "openai-realtime",
      sessionKey: "voice:test",
      ticket: "ticket-123",
    });

    expect(records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          2: "voice bootstrap request",
          1: expect.objectContaining({
            providerId: "openai-realtime",
            sessionKey: "voice:test",
            ticket: "ticket-123",
          }),
          _meta: expect.objectContaining({
            logLevelName: "INFO",
          }),
        }),
      ]),
    );
    const fileContent = fs.readFileSync(logPath, "utf8");
    expect(fileContent).toContain("voice bootstrap request");
    expect(fileContent).toContain("\"sessionKey\":\"voice:test\"");
  });

  it("emits payload logs without requiring OPENCLAW_LOG_LEVEL=debug", async () => {
    process.env.OPENCLAW_DEBUG_VOICE = "1";
    process.env.OPENCLAW_DEBUG_VOICE_PAYLOADS = "1";
    const logPath = tempLogPath();
    const records: Array<Record<string, unknown>> = [];
    setLoggerOverride({
      level: "info",
      consoleLevel: "silent",
      file: logPath,
    });
    unregisterTransport = registerLogTransport((record) => {
      records.push(record);
    });

    const { createVoiceDebugLogger } = await import("./debug.js");
    const logger = createVoiceDebugLogger("gateway/voice");
    logger.payload(
      "voice bootstrap request payload",
      {
        apiKey: "secret",
        sessionKey: "voice:test",
        text: "hello",
      },
      { providerId: "openai-realtime" },
    );

    expect(records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          2: "voice bootstrap request payload",
          1: expect.objectContaining({
            providerId: "openai-realtime",
            payload: {
              apiKey: "[redacted]",
              sessionKey: "voice:test",
              text: "hello",
            },
          }),
          _meta: expect.objectContaining({
            logLevelName: "INFO",
          }),
        }),
      ]),
    );
    const fileContent = fs.readFileSync(logPath, "utf8");
    expect(fileContent).toContain("voice bootstrap request payload");
    expect(fileContent).toContain("\"apiKey\":\"[redacted]\"");
    expect(fileContent).not.toContain("\"apiKey\":\"secret\"");
  });
});
