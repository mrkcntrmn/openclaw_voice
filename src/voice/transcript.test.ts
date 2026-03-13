import fs from "node:fs";
import path from "node:path";
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

const sessionState = vi.hoisted(() => ({
  appendMessage: vi.fn(),
  loadSessionEntry: vi.fn(),
  readSessionMessages: vi.fn(),
  emitSessionTranscriptUpdate: vi.fn(),
  saveSessionStore: vi.fn(async () => undefined),
}));

vi.mock("./debug.js", () => ({
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
  voiceDebugElapsedMs: () => 5,
}));

vi.mock("@mariozechner/pi-coding-agent", () => ({
  CURRENT_SESSION_VERSION: 1,
  SessionManager: {
    open: () => ({
      appendMessage: sessionState.appendMessage,
    }),
  },
}));

vi.mock("../agents/agent-scope.js", () => ({
  resolveDefaultAgentId: () => "main",
}));

vi.mock("../config/config.js", () => ({
  loadConfig: () => ({ session: {} }),
}));

const testDataDir = path.join(process.cwd(), ".tmp-voice-transcript-tests");
const sessionFile = path.join(testDataDir, "voice-session.jsonl");

vi.mock("../config/sessions.js", () => ({
  loadSessionStore: () => ({}),
  resolveStorePath: () => path.join(testDataDir, "sessions.json"),
  resolveSessionFilePath: () => sessionFile,
  saveSessionStore: sessionState.saveSessionStore,
}));

vi.mock("../sessions/transcript-events.js", () => ({
  emitSessionTranscriptUpdate: sessionState.emitSessionTranscriptUpdate,
}));

vi.mock("../gateway/session-utils.js", () => ({
  loadSessionEntry: (...args: unknown[]) => sessionState.loadSessionEntry(...args),
  readSessionMessages: (...args: unknown[]) => sessionState.readSessionMessages(...args),
}));

import { appendVoiceTranscriptMessage, loadVoiceConversationHistory } from "./transcript.js";

describe("voice transcript logging", () => {
  const envSnapshot = new Map<string, string | undefined>();

  beforeEach(() => {
    fs.rmSync(testDataDir, { recursive: true, force: true });
    fs.mkdirSync(testDataDir, { recursive: true });
    debugState.debugCalls.length = 0;
    debugState.payloadCalls.length = 0;
    sessionState.appendMessage.mockReset();
    sessionState.loadSessionEntry.mockReset();
    sessionState.readSessionMessages.mockReset();
    sessionState.emitSessionTranscriptUpdate.mockReset();
    sessionState.saveSessionStore.mockClear();
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
    fs.rmSync(testDataDir, { recursive: true, force: true });
  });

  it("logs append lifecycle metadata and payloads", async () => {
    process.env.OPENCLAW_DEBUG_VOICE = "1";
    process.env.OPENCLAW_DEBUG_VOICE_PAYLOADS = "1";
    sessionState.loadSessionEntry.mockReturnValue({
      entry: null,
      storePath: path.join(testDataDir, "sessions.json"),
    });

    await appendVoiceTranscriptMessage({
      sessionKey: "voice:test",
      role: "user",
      text: "Hello there",
      providerId: "openai-realtime",
      modelId: "gpt-4o-realtime-preview",
    });

    expect(sessionState.appendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        role: "user",
        provider: "openai-realtime",
        model: "gpt-4o-realtime-preview",
      }),
    );
    expect(debugState.debugCalls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ subsystem: "voice/transcript", message: "voice transcript session entry" }),
        expect.objectContaining({ subsystem: "voice/transcript", message: "voice transcript append" }),
        expect.objectContaining({ subsystem: "voice/transcript", message: "voice transcript append complete" }),
      ]),
    );
    expect(debugState.payloadCalls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          subsystem: "voice/transcript",
          message: "voice transcript append payload",
          payload: expect.objectContaining({ text: "Hello there", role: "user" }),
        }),
      ]),
    );
  });

  it("logs history refresh metadata and payloads", () => {
    process.env.OPENCLAW_DEBUG_VOICE = "1";
    process.env.OPENCLAW_DEBUG_VOICE_PAYLOADS = "1";
    sessionState.loadSessionEntry.mockReturnValue({
      entry: { sessionId: "session-1", sessionFile },
      storePath: path.join(testDataDir, "sessions.json"),
    });
    sessionState.readSessionMessages.mockReturnValue([
      { role: "system", text: "skip me" },
      { role: "user", text: "hello", timestamp: 1 },
      { role: "assistant", content: [{ type: "text", text: "hi there" }], timestamp: 2 },
    ]);

    const history = loadVoiceConversationHistory({ sessionKey: "voice:test", limit: 8 });

    expect(history).toEqual([
      { role: "user", text: "hello", timestamp: 1 },
      { role: "assistant", text: "hi there", timestamp: 2 },
    ]);
    expect(debugState.debugCalls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          subsystem: "voice/transcript",
          message: "voice history refresh",
          meta: expect.objectContaining({ sessionKey: "voice:test", found: true, turnCount: 2 }),
        }),
      ]),
    );
    expect(debugState.payloadCalls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          subsystem: "voice/transcript",
          message: "voice history refresh payload",
          payload: history,
        }),
      ]),
    );
  });
});
