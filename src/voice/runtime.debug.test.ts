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

const transcriptState = vi.hoisted(() => ({
  appendVoiceTranscriptMessage: vi.fn(async () => undefined),
  loadVoiceConversationHistory: vi.fn(() => []),
}));

const wsState = vi.hoisted(() => ({
  instances: [] as Array<{
    sent: string[];
    emitJson: (payload: unknown) => void;
    close: () => void;
  }>,
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
  voiceDebugElapsedMs: () => 7,
}));

vi.mock("./transcript.js", () => ({
  appendVoiceTranscriptMessage: transcriptState.appendVoiceTranscriptMessage,
  loadVoiceConversationHistory: transcriptState.loadVoiceConversationHistory,
}));

vi.mock("ws", () => {
  class FakeWebSocket {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSED = 3;

    readonly sent: string[] = [];
    readonly listeners = new Map<string, Set<(...args: unknown[]) => void>>();
    readyState = FakeWebSocket.CONNECTING;

    constructor() {
      wsState.instances.push(this as never);
      queueMicrotask(() => {
        this.readyState = FakeWebSocket.OPEN;
        this.emit("open");
      });
    }

    on(type: string, listener: (...args: unknown[]) => void): this {
      const existing = this.listeners.get(type) ?? new Set();
      existing.add(listener);
      this.listeners.set(type, existing);
      return this;
    }

    once(type: string, listener: (...args: unknown[]) => void): this {
      const wrapped = (...args: unknown[]) => {
        this.off(type, wrapped);
        listener(...args);
      };
      return this.on(type, wrapped);
    }

    off(type: string, listener: (...args: unknown[]) => void): this {
      this.listeners.get(type)?.delete(listener);
      return this;
    }

    emit(type: string, ...args: unknown[]): void {
      for (const listener of this.listeners.get(type) ?? []) {
        listener(...args);
      }
    }

    send(payload: string): void {
      this.sent.push(payload);
    }

    close(): void {
      this.readyState = FakeWebSocket.CLOSED;
      this.emit("close");
    }

    emitJson(payload: unknown): void {
      this.emit("message", JSON.stringify(payload), false);
    }
  }

  return { default: FakeWebSocket };
});

import { createVoiceAdapter, VoiceAdapter, VoiceSessionOrchestrator } from "./runtime.js";

class TestAdapter extends VoiceAdapter {
  override async connect(): Promise<void> {}
  override sendAudio(): void {}
  override sendText(): void {}
  override sendToolResult(): void {}
  override interrupt(): void {}
  override close(): void {}
}

describe("voice runtime debug logging", () => {
  const envSnapshot = new Map<string, string | undefined>();

  beforeEach(() => {
    wsState.instances.length = 0;
    debugState.debugCalls.length = 0;
    debugState.payloadCalls.length = 0;
    transcriptState.appendVoiceTranscriptMessage.mockReset();
    transcriptState.loadVoiceConversationHistory.mockReset();
    for (const key of ["OPENCLAW_DEBUG_VOICE", "OPENCLAW_DEBUG_VOICE_PAYLOADS", "OPENCLAW_DEBUG_VOICE_FORCE_COMMIT"]) {
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
  });

  it("logs provider lifecycle metadata and payloads for OpenAI realtime", async () => {
    process.env.OPENCLAW_DEBUG_VOICE = "1";
    process.env.OPENCLAW_DEBUG_VOICE_PAYLOADS = "1";

    const adapter = createVoiceAdapter("openai-realtime");
    await adapter.connect({
      provider: { apiKey: "sk-test" } as never,
      providerId: "openai-realtime",
      modelId: "gpt-4o-realtime-preview",
      sampleRateHz: 24_000,
      instructions: "Keep it concise.",
      tools: [],
      history: [],
    });

    const ws = wsState.instances[0];
    ws?.emitJson({ type: "session.created", session: { modalities: ["audio", "text"] } });
    ws?.emitJson({
      type: "session.updated",
      session: {
        modalities: ["audio", "text"],
        turn_detection: { type: "server_vad" },
        input_audio_transcription: { model: "gpt-4o-mini-transcribe" },
        tools: [],
      },
    });
    ws?.emitJson({ type: "response.audio_transcript.delta", delta: "hello" });
    ws?.emitJson({ type: "response.audio_transcript.done", transcript: "hello there" });

    expect(debugState.debugCalls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ subsystem: "voice", message: "voice provider connect start" }),
        expect.objectContaining({ subsystem: "voice", message: "voice provider connect complete" }),
        expect.objectContaining({ subsystem: "voice", message: "voice provider event" }),
        expect.objectContaining({ subsystem: "voice", message: "voice session diagnostics" }),
        expect.objectContaining({ subsystem: "voice", message: "voice transcript event" }),
      ]),
    );
    expect(debugState.payloadCalls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          subsystem: "voice",
          message: "voice provider event payload",
          payload: expect.objectContaining({ type: "response.audio_transcript.done", transcript: "hello there" }),
        }),
      ]),
    );
  });

  it("warns when audio uploads never produce speech or transcript events", async () => {
    process.env.OPENCLAW_DEBUG_VOICE = "1";
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-12T04:25:44.000Z"));

    try {
      const adapter = createVoiceAdapter("openai-realtime");
      await adapter.connect({
        provider: { apiKey: "sk-test" } as never,
        providerId: "openai-realtime",
        modelId: "gpt-4o-realtime-preview",
        sampleRateHz: 24_000,
        instructions: "Keep it concise.",
        tools: [],
        history: [],
      });

      const ws = wsState.instances[0];
      ws?.emitJson({ type: "session.created", session: { modalities: ["audio", "text"] } });
      ws?.emitJson({
        type: "session.updated",
        session: {
          modalities: ["audio", "text"],
          turn_detection: { type: "server_vad" },
          input_audio_transcription: { model: "gpt-4o-mini-transcribe" },
          tools: [],
        },
      });

      for (let index = 0; index < 30; index += 1) {
        vi.setSystemTime(Date.now() + 120);
        adapter.sendAudio(Buffer.alloc(640));
      }

      expect(debugState.debugCalls).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            subsystem: "voice",
            message: "voice provider warning",
            meta: expect.objectContaining({
              reason: "no-speech-detected-after-audio-upload",
            }),
          }),
          expect.objectContaining({
            subsystem: "voice",
            message: "voice provider warning",
            meta: expect.objectContaining({
              reason: "bootstrap-events-only-after-audio-upload",
            }),
          }),
        ]),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not force-commit a turn without the debug fallback flag", async () => {
    process.env.OPENCLAW_DEBUG_VOICE = "1";

    const adapter = createVoiceAdapter("openai-realtime");
    await adapter.connect({
      provider: { apiKey: "sk-test" } as never,
      providerId: "openai-realtime",
      modelId: "gpt-4o-realtime-preview",
      sampleRateHz: 24_000,
      instructions: "Keep it concise.",
      tools: [],
      history: [],
    });

    const ws = wsState.instances[0];
    ws?.emitJson({ type: "session.created", session: { modalities: ["audio", "text"] } });
    ws?.emitJson({
      type: "session.updated",
      session: {
        modalities: ["audio", "text"],
        turn_detection: { type: "server_vad" },
        input_audio_transcription: { model: "gpt-4o-mini-transcribe" },
        tools: [],
      },
    });
    ws?.emitJson({ type: "input_audio_buffer.speech_started" });

    for (let index = 0; index < 65; index += 1) {
      adapter.sendAudio(Buffer.alloc(640));
    }

    const sentTypes = ws?.sent.map((payload) => JSON.parse(payload).type) ?? [];
    expect(sentTypes).not.toContain("input_audio_buffer.commit");
    expect(sentTypes.filter((type) => type === "response.create")).toHaveLength(0);
  });

  it("forces commit after quiet audio when the debug fallback flag is enabled", async () => {
    process.env.OPENCLAW_DEBUG_VOICE = "1";
    process.env.OPENCLAW_DEBUG_VOICE_FORCE_COMMIT = "1";

    const adapter = createVoiceAdapter("openai-realtime");
    await adapter.connect({
      provider: { apiKey: "sk-test" } as never,
      providerId: "openai-realtime",
      modelId: "gpt-4o-realtime-preview",
      sampleRateHz: 24_000,
      instructions: "Keep it concise.",
      tools: [],
      history: [],
    });

    const ws = wsState.instances[0];
    ws?.emitJson({ type: "session.created", session: { modalities: ["audio", "text"] } });
    ws?.emitJson({
      type: "session.updated",
      session: {
        modalities: ["audio", "text"],
        turn_detection: { type: "server_vad" },
        input_audio_transcription: { model: "gpt-4o-mini-transcribe" },
        tools: [],
      },
    });
    ws?.emitJson({ type: "input_audio_buffer.speech_started" });

    for (let index = 0; index < 65; index += 1) {
      adapter.sendAudio(Buffer.alloc(640));
    }

    const sentTypes = ws?.sent.map((payload) => JSON.parse(payload).type) ?? [];
    expect(sentTypes).toContain("input_audio_buffer.commit");
    expect(sentTypes.filter((type) => type === "response.create").length).toBeGreaterThan(0);
    expect(debugState.debugCalls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          subsystem: "voice",
          message: "voice provider fallback",
          meta: expect.objectContaining({ reason: "quiet-audio-threshold" }),
        }),
      ]),
    );
  });

  it("forces commit after an idle gap when the debug fallback flag is enabled", async () => {
    process.env.OPENCLAW_DEBUG_VOICE = "1";
    process.env.OPENCLAW_DEBUG_VOICE_FORCE_COMMIT = "1";
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-12T04:25:44.000Z"));

    try {
      const adapter = createVoiceAdapter("openai-realtime");
      await adapter.connect({
        provider: { apiKey: "sk-test" } as never,
        providerId: "openai-realtime",
        modelId: "gpt-4o-realtime-preview",
        sampleRateHz: 24_000,
        instructions: "Keep it concise.",
        tools: [],
        history: [],
      });

      const ws = wsState.instances[0];
      ws?.emitJson({ type: "session.created", session: { modalities: ["audio", "text"] } });
      ws?.emitJson({
        type: "session.updated",
        session: {
          modalities: ["audio", "text"],
          turn_detection: { type: "server_vad" },
          input_audio_transcription: { model: "gpt-4o-mini-transcribe" },
          tools: [],
        },
      });
      ws?.emitJson({ type: "input_audio_buffer.speech_started" });

      adapter.sendAudio(Buffer.from(Int16Array.from(new Array(320).fill(4096)).buffer));
      vi.advanceTimersByTime(1_501);

      const sentTypes = ws?.sent.map((payload) => JSON.parse(payload).type) ?? [];
      expect(sentTypes).toContain("input_audio_buffer.commit");
      expect(debugState.debugCalls).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            subsystem: "voice",
            message: "voice provider fallback",
            meta: expect.objectContaining({ reason: "idle-timeout" }),
          }),
        ]),
      );
    } finally {
      vi.useRealTimers();
    }
  });
  it("logs tool execution and transcript persistence when the orchestrator handles final turns", async () => {
    process.env.OPENCLAW_DEBUG_VOICE = "1";
    process.env.OPENCLAW_DEBUG_VOICE_PAYLOADS = "1";

    const adapter = new TestAdapter();
    const execute = vi.fn(async (call: { callId: string; name: string; arguments: Record<string, unknown> }) => ({
      ...call,
      output: "ok",
    }));
    const orchestrator = new VoiceSessionOrchestrator({
      adapter,
      toolRuntime: { definitions: [], execute },
      sessionKey: "voice:test",
      providerId: "openai-realtime",
      modelId: "gpt-4o-realtime-preview",
      persistTranscripts: true,
      pauseOnToolCall: true,
      interruptOnSpeech: true,
    });

    await orchestrator.connect({
      provider: {} as never,
      providerId: "openai-realtime",
      modelId: "gpt-4o-realtime-preview",
      sampleRateHz: 24_000,
      instructions: "Keep it concise.",
      tools: [],
      history: [],
    });

    adapter.emit("tool_call", {
      callId: "call-1",
      name: "lookup",
      arguments: { query: "openclaw" },
    });
    adapter.emit("transcript", { role: "user", text: "hello there", final: true });

    await vi.waitFor(() => {
      expect(execute).toHaveBeenCalledTimes(1);
      expect(transcriptState.appendVoiceTranscriptMessage).toHaveBeenCalledTimes(1);
    });

    expect(debugState.debugCalls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ subsystem: "voice", message: "voice tool execution" }),
        expect.objectContaining({ subsystem: "voice", message: "voice transcript persist" }),
      ]),
    );
    expect(debugState.payloadCalls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          subsystem: "voice",
          message: "voice transcript persist payload",
          payload: expect.objectContaining({ text: "hello there", role: "user" }),
        }),
      ]),
    );
  });
});

