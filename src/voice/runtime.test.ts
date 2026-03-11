import { afterEach, describe, expect, it, vi } from "vitest";

const transcriptMocks = vi.hoisted(() => ({
  appendVoiceTranscriptMessage: vi.fn(async () => undefined),
}));

vi.mock("./transcript.js", async () => {
  const actual = await vi.importActual<typeof import("./transcript.js")>("./transcript.js");
  return {
    ...actual,
    appendVoiceTranscriptMessage: transcriptMocks.appendVoiceTranscriptMessage,
  };
});

import { VoiceAdapter, VoiceSessionOrchestrator } from "./runtime.js";

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

afterEach(() => {
  transcriptMocks.appendVoiceTranscriptMessage.mockReset();
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
