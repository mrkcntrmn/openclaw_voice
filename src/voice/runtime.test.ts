import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const transcriptMocks = vi.hoisted(() => ({
  appendVoiceTranscriptMessage: vi.fn(async () => undefined),
  loadVoiceConversationHistory: vi.fn(() => []),
})) as {
  appendVoiceTranscriptMessage: ReturnType<typeof vi.fn>;
  loadVoiceConversationHistory: ReturnType<typeof vi.fn>;
};

const wsMockState = vi.hoisted(() => ({
  instances: [],
})) as {
  instances: Array<{
    url: string;
    headers?: Record<string, string>;
    sent: Array<string | Buffer>;
    emitJson: (payload: unknown) => void;
  }>;
};

vi.mock("./transcript.js", () => ({
  appendVoiceTranscriptMessage: transcriptMocks.appendVoiceTranscriptMessage,
  loadVoiceConversationHistory: transcriptMocks.loadVoiceConversationHistory,
}));

vi.mock("ws", () => {
  class FakeWebSocket {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSING = 2;
    static readonly CLOSED = 3;

    readonly url: string;
    readonly headers?: Record<string, string>;
    readonly sent: Array<string | Buffer> = [];
    readonly listeners = new Map<string, Set<(...args: unknown[]) => void>>();
    readyState = FakeWebSocket.CONNECTING;

    constructor(url: string, options?: { headers?: Record<string, string> }) {
      this.url = url;
      this.headers = options?.headers;
      wsMockState.instances.push(this as never);
      queueMicrotask(() => {
        if (this.readyState !== FakeWebSocket.CONNECTING) {
          return;
        }
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

    send(payload: string | Buffer): void {
      this.sent.push(payload);
    }

    close(code = 1000, reason = ""): void {
      if (this.readyState === FakeWebSocket.CLOSED) {
        return;
      }
      this.readyState = FakeWebSocket.CLOSED;
      this.emit("close", code, Buffer.from(reason));
    }

    emitJson(payload: unknown): void {
      this.emit("message", JSON.stringify(payload), false);
    }
  }

  return { default: FakeWebSocket };
});

import {
  createVoiceAdapter,
  resolveVoiceSessionConfig,
  VoiceAdapter,
  VoiceSessionOrchestrator,
} from "./runtime.js";

class TestAdapter extends VoiceAdapter {
  readonly connectMock = vi.fn(async () => undefined);
  readonly sendAudioMock = vi.fn();
  readonly sendTextMock = vi.fn();
  readonly sendToolResultMock = vi.fn();
  readonly interruptMock = vi.fn();
  readonly closeMock = vi.fn();

  override async connect(options: unknown): Promise<void> {
    await this.connectMock(options);
  }

  override sendAudio(audio: Buffer): void {
    this.sendAudioMock(audio);
  }

  override sendText(text: string): void {
    this.sendTextMock(text);
  }

  override sendToolResult(callId: string, output: string, name?: string): void {
    this.sendToolResultMock(callId, output, name);
  }

  override interrupt(): void {
    this.interruptMock();
  }

  override close(): void {
    this.closeMock();
  }
}

function createConnectOptions() {
  return {
    provider: {} as never,
    providerId: "openai-realtime",
    modelId: "gpt-4o-realtime-preview",
    instructions: "Keep it concise.",
    tools: [],
    history: [],
  };
}

function createLiveConnectOptions(providerId: string, apiKey: string) {
  return {
    provider: { apiKey } as never,
    providerId,
    modelId:
      providerId === "gemini-live" ? "gemini-2.0-flash-exp" : "gpt-4o-realtime-preview",
    instructions: "Keep it concise.",
    tools: [],
    history: [],
  };
}

const envKeys = ["OPENAI_API_KEY", "GOOGLE_API_KEY", "GEMINI_API_KEY", "VOICE_TEST_API_KEY"];
const envSnapshot = new Map<string, string | undefined>();

beforeEach(() => {
  wsMockState.instances.length = 0;
  for (const key of envKeys) {
    envSnapshot.set(key, process.env[key]);
    delete process.env[key];
  }
});

afterEach(() => {
  transcriptMocks.appendVoiceTranscriptMessage.mockReset();
  wsMockState.instances.length = 0;
  for (const key of envKeys) {
    const value = envSnapshot.get(key);
    if (value === undefined) {
      delete process.env[key];
      continue;
    }
    process.env[key] = value;
  }
  envSnapshot.clear();
});

describe("resolveVoiceSessionConfig", () => {
  it("prefers the requested provider over the configured default", async () => {
    const resolved = await resolveVoiceSessionConfig({
      cfg: {
        voice: {
          provider: "gemini-live",
          providers: {
            "gemini-live": { apiKey: "sk-gemini", modelId: "gemini-custom" },
            "openai-realtime": { apiKey: "sk-openai", modelId: "gpt-4o-realtime-preview" },
          },
        },
      } as never,
      providerId: "openai-realtime",
    });

    expect(resolved.providerId).toBe("openai-realtime");
    expect(resolved.provider.apiKey).toBe("sk-openai");
    expect(resolved.modelId).toBe("gpt-4o-realtime-preview");
  });

  it("resolves env-backed SecretRef api keys", async () => {
    process.env.VOICE_TEST_API_KEY = "sk-from-env";

    const resolved = await resolveVoiceSessionConfig({
      cfg: {
        voice: {
          provider: "openai-realtime",
          providers: {
            "openai-realtime": {
              apiKey: {
                source: "env",
                provider: "default",
                id: "VOICE_TEST_API_KEY",
              },
            },
          },
        },
      } as never,
    });

    expect(resolved.provider.apiKey).toBe("sk-from-env");
  });

  it.each([
    {
      label: "non-mono browser audio",
      voice: { browser: { channels: 2 } },
      message: "voice.browser.channels must be 1 for browser voice",
    },
    {
      label: "client-side VAD",
      voice: { browser: { vad: "client" } },
      message: 'voice.browser.vad must be "provider" for browser voice',
    },
    {
      label: "isolated voice chat history",
      voice: { session: { sharedChatHistory: false } },
      message: "voice.session.sharedChatHistory must be true for browser voice",
    },
  ])("rejects unsupported browser MVP config: $label", async ({ voice, message }) => {
    await expect(
      resolveVoiceSessionConfig({
        cfg: {
          voice: {
            provider: "openai-realtime",
            providers: {
              "openai-realtime": { apiKey: "sk-test" },
            },
            ...voice,
          },
        } as never,
      }),
    ).rejects.toThrow(message);
  });

  it("resolves browser defaults and websocket session timeout", async () => {
    const resolved = await resolveVoiceSessionConfig({
      cfg: {
        voice: {
          provider: "openai-realtime",
          providers: {
            "openai-realtime": { apiKey: "sk-test" },
          },
          deployment: {
            websocket: {
              maxSessionMinutes: 9,
            },
          },
        },
      } as never,
    });

    expect(resolved.browser.channels).toBe(1);
    expect(resolved.browser.vad).toBe("provider");
    expect(resolved.session.sharedChatHistory).toBe(true);
    expect(resolved.deployment.websocket.maxSessionMinutes).toBe(9);
  });
});

describe("voice adapters", () => {
  it("translates OpenAI realtime events and outbound tool results", async () => {
    const adapter = createVoiceAdapter("openai-realtime");
    const states: string[] = [];
    const transcripts: Array<{ role: string; text: string; final: boolean }> = [];
    const toolCalls: Array<{ callId: string; name: string; arguments: Record<string, unknown> }> = [];
    const audio: Buffer[] = [];
    const errors: string[] = [];

    adapter.on("state", (event) => states.push(event.state));
    adapter.on("transcript", (event) => transcripts.push(event));
    adapter.on("tool_call", (event) => toolCalls.push(event));
    adapter.on("audio", (chunk) => audio.push(chunk));
    adapter.on("error", (event) => errors.push(event.message));

    await adapter.connect(createLiveConnectOptions("openai-realtime", "sk-openai"));

    const ws = wsMockState.instances[0];
    expect(ws?.url).toContain("api.openai.com");
    expect(JSON.parse(String(ws?.sent[0]))).toMatchObject({
      type: "session.update",
      session: {
        modalities: ["text", "audio"],
      },
    });

    ws?.emitJson({ type: "session.created" });
    ws?.emitJson({ type: "conversation.item.input_audio_transcription.completed", transcript: "hello" });
    ws?.emitJson({ type: "response.audio_transcript.done", transcript: "hi there" });
    ws?.emitJson({ type: "response.audio.delta", delta: Buffer.from("pcm").toString("base64") });
    ws?.emitJson({
      type: "response.function_call_arguments.done",
      call_id: "call-1",
      name: "lookup",
      arguments: JSON.stringify({ query: "openclaw" }),
    });
    ws?.emitJson({ type: "error", error: { message: "openai boom" } });

    adapter.sendToolResult("call-1", "ok", "lookup");
    adapter.close();

    expect(states).toContain("connected");
    expect(states).toContain("closed");
    expect(transcripts).toEqual([
      { role: "user", text: "hello", final: true },
      { role: "assistant", text: "hi there", final: true },
    ]);
    expect(toolCalls).toEqual([
      {
        callId: "call-1",
        name: "lookup",
        arguments: { query: "openclaw" },
      },
    ]);
    expect(audio[0]?.toString()).toBe("pcm");
    expect(errors).toContain("openai boom");
    expect(ws?.sent.some((payload) => String(payload).includes("function_call_output"))).toBe(true);
  });

  it("translates Gemini live events and outbound tool results", async () => {
    const adapter = createVoiceAdapter("gemini-live");
    const states: string[] = [];
    const transcripts: Array<{ role: string; text: string; final: boolean }> = [];
    const toolCalls: Array<{ callId: string; name: string; arguments: Record<string, unknown> }> = [];
    const audio: Buffer[] = [];
    const errors: string[] = [];

    adapter.on("state", (event) => states.push(event.state));
    adapter.on("transcript", (event) => transcripts.push(event));
    adapter.on("tool_call", (event) => toolCalls.push(event));
    adapter.on("audio", (chunk) => audio.push(chunk));
    adapter.on("error", (event) => errors.push(event.message));

    await adapter.connect(createLiveConnectOptions("gemini-live", "sk-gemini"));

    const ws = wsMockState.instances[0];
    expect(JSON.parse(String(ws?.sent[0]))).toMatchObject({
      setup: {
        model: "models/gemini-2.0-flash-exp",
      },
    });

    ws?.emitJson({ setupComplete: true });
    ws?.emitJson({
      serverContent: {
        inputTranscription: { text: "hello" },
        outputTranscription: { transcript: "hi there" },
        modelTurn: {
          parts: [
            {
              inlineData: {
                data: Buffer.from("gemini-audio").toString("base64"),
              },
            },
          ],
        },
        turnComplete: true,
      },
    });
    ws?.emitJson({
      toolCall: {
        functionCalls: [
          {
            id: "call-2",
            name: "lookup",
            args: { query: "openclaw" },
          },
        ],
      },
    });
    ws?.emitJson({ error: { message: "gemini boom" } });

    adapter.sendToolResult("call-2", "ok", "lookup");
    adapter.close();

    expect(states).toContain("connected");
    expect(states).toContain("responding");
    expect(states).toContain("closed");
    expect(transcripts).toEqual([
      { role: "user", text: "hello", final: true },
      { role: "assistant", text: "hi there", final: true },
    ]);
    expect(toolCalls).toEqual([
      {
        callId: "call-2",
        name: "lookup",
        arguments: { query: "openclaw" },
      },
    ]);
    expect(audio[0]?.toString()).toBe("gemini-audio");
    expect(errors).toContain("gemini boom");
    expect(ws?.sent.some((payload) => String(payload).includes("toolResponse"))).toBe(true);
  });
});

describe("VoiceSessionOrchestrator", () => {
  it("persists final transcripts once per unique final turn", async () => {
    const adapter = new TestAdapter();
    const orchestrator = new VoiceSessionOrchestrator({
      adapter,
      toolRuntime: {
        definitions: [],
        execute: vi.fn(async (call) => ({ ...call, output: "ok" })),
      },
      sessionKey: "voice:browser:test-session",
      providerId: "openai-realtime",
      modelId: "gpt-4o-realtime-preview",
      persistTranscripts: true,
      pauseOnToolCall: true,
      interruptOnSpeech: true,
    });

    await orchestrator.connect(createConnectOptions());
    adapter.emit("transcript", { role: "user", text: "hello", final: true });
    adapter.emit("transcript", { role: "user", text: "hello", final: true });
    adapter.emit("transcript", { role: "assistant", text: "hi there", final: true });

    await vi.waitFor(() => {
      expect(transcriptMocks.appendVoiceTranscriptMessage).toHaveBeenCalledTimes(2);
    });
    expect(transcriptMocks.appendVoiceTranscriptMessage.mock.calls[0]?.[0]).toMatchObject({
      sessionKey: "voice:browser:test-session",
      role: "user",
      text: "hello",
      providerId: "openai-realtime",
      modelId: "gpt-4o-realtime-preview",
    });
    expect(transcriptMocks.appendVoiceTranscriptMessage.mock.calls[1]?.[0]).toMatchObject({
      role: "assistant",
      text: "hi there",
    });
  });

  it("interrupts assistant playback when speech starts during a response", async () => {
    const adapter = new TestAdapter();
    const orchestrator = new VoiceSessionOrchestrator({
      adapter,
      toolRuntime: {
        definitions: [],
        execute: vi.fn(async (call) => ({ ...call, output: "ok" })),
      },
      sessionKey: "voice:browser:test-session",
      providerId: "openai-realtime",
      modelId: "gpt-4o-realtime-preview",
      persistTranscripts: false,
      pauseOnToolCall: true,
      interruptOnSpeech: true,
    });

    await orchestrator.connect(createConnectOptions());
    adapter.emit("state", { state: "responding" });
    adapter.emit("state", { state: "listening", detail: "speech-start" });

    expect(adapter.interruptMock).toHaveBeenCalledTimes(1);
  });

  it("executes tool calls, emits tool results, and forwards results back to the adapter", async () => {
    const adapter = new TestAdapter();
    const execute = vi.fn(async (call: { callId: string; name: string; arguments: Record<string, unknown> }) => ({
      ...call,
      output: "tool-output",
    }));
    const orchestrator = new VoiceSessionOrchestrator({
      adapter,
      toolRuntime: {
        definitions: [],
        execute,
      },
      sessionKey: "voice:browser:test-session",
      providerId: "openai-realtime",
      modelId: "gpt-4o-realtime-preview",
      persistTranscripts: false,
      pauseOnToolCall: true,
      interruptOnSpeech: true,
    });
    const states: Array<{ state: string; detail?: string }> = [];
    const results: Array<{ callId: string; name: string; output: string }> = [];
    orchestrator.on("state", (event) => {
      states.push({ state: event.state, detail: event.detail });
    });
    orchestrator.on("tool_result", (event) => {
      results.push({ callId: event.callId, name: event.name, output: event.output });
    });

    await orchestrator.connect(createConnectOptions());
    adapter.emit("tool_call", {
      callId: "call-1",
      name: "session_status",
      arguments: { sessionKey: "voice:browser:test-session" },
    });

    await vi.waitFor(() => {
      expect(execute).toHaveBeenCalledTimes(1);
      expect(adapter.sendToolResultMock).toHaveBeenCalledWith("call-1", "tool-output", "session_status");
    });
    expect(results).toEqual([
      {
        callId: "call-1",
        name: "session_status",
        output: "tool-output",
      },
    ]);
    expect(states).toEqual(
      expect.arrayContaining([
        { state: "tool", detail: "session_status" },
        { state: "responding", detail: "tool:session_status" },
      ]),
    );
  });
});



