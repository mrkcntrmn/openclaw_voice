import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const chatMocks = vi.hoisted(() => ({
  loadChatHistory: vi.fn(async () => undefined),
}));

vi.mock("./chat.ts", () => ({
  loadChatHistory: chatMocks.loadChatHistory,
}));

import {
  handleVoiceConnect,
  handleVoiceDisconnect,
  handleVoiceInterrupt,
  refreshVoiceConfig,
} from "./voice.ts";

const wsInstances: FakeWebSocket[] = [];
const workletInstances: FakeAudioWorkletNode[] = [];
const playbackSampleRates: number[] = [];

class FakeTrack {
  stopped = false;

  stop(): void {
    this.stopped = true;
  }
}

class FakeMediaStream {
  private readonly tracks = [new FakeTrack()];

  getTracks(): FakeTrack[] {
    return this.tracks;
  }
}

class FakeAudioNode {
  connect = vi.fn(() => this);
  disconnect = vi.fn();
}

class FakeGainNode extends FakeAudioNode {
  gain = { value: 1 };
}

class FakeAudioBufferSourceNode extends FakeAudioNode {
  buffer: { duration: number } | null = null;
  addEventListener = vi.fn();
  start = vi.fn();
}

class FakeAudioContext {
  state: "running" | "closed" = "running";
  currentTime = 0;
  destination = {};
  audioWorklet = {
    addModule: vi.fn(async () => undefined),
  };

  async resume(): Promise<void> {
    return;
  }

  async close(): Promise<void> {
    this.state = "closed";
  }

  createMediaStreamSource(): FakeAudioNode {
    return new FakeAudioNode();
  }

  createGain(): FakeGainNode {
    return new FakeGainNode();
  }

  createBuffer(_channels: number, length: number, sampleRate: number) {
    playbackSampleRates.push(sampleRate);
    return {
      duration: length / sampleRate,
      copyToChannel: vi.fn(),
    };
  }

  createBufferSource(): FakeAudioBufferSourceNode {
    return new FakeAudioBufferSourceNode();
  }
}

class FakeAudioWorkletNode extends FakeAudioNode {
  private readonly messageListeners = new Set<(event: { data: unknown }) => void>();
  port = {
    onmessage: null as ((event: { data: ArrayBuffer }) => void) | null,
    addEventListener: vi.fn((type: string, listener: (event: { data: unknown }) => void) => {
      if (type === "message") {
        this.messageListeners.add(listener);
      }
    }),
    start: vi.fn(),
    close: vi.fn(),
  };

  constructor(_context: unknown, _name: string, _options?: unknown) {
    super();
    workletInstances.push(this);
  }

  emitAudioFrame(data: ArrayBuffer): void {
    const event = { data: { type: "audio", payload: data } };
    for (const listener of this.messageListeners) {
      listener(event);
    }
  }

  emitVolume(value: number): void {
    const event = { data: { type: "volume", value } };
    for (const listener of this.messageListeners) {
      listener(event);
    }
  }
}

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readonly sent: Array<string | ArrayBuffer> = [];
  readonly listeners = new Map<string, Set<(event: unknown) => void>>();
  readonly url: string;
  readyState = FakeWebSocket.CONNECTING;
  binaryType = "blob";

  constructor(url: string) {
    this.url = url;
    wsInstances.push(this);
  }

  addEventListener(type: string, listener: (event: unknown) => void): void {
    const existing = this.listeners.get(type) ?? new Set();
    existing.add(listener);
    this.listeners.set(type, existing);
  }

  removeEventListener(type: string, listener: (event: unknown) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  send(payload: string | ArrayBuffer): void {
    this.sent.push(payload);
  }

  close(code = 1000, reason = ""): void {
    if (this.readyState === FakeWebSocket.CLOSED) {
      return;
    }
    this.readyState = FakeWebSocket.CLOSED;
    this.emit("close", { code, reason });
  }

  emitOpen(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.emit("open", {});
  }

  emitError(): void {
    this.emit("error", {});
  }

  emitMessage(data: unknown): void {
    this.emit("message", { data });
  }

  private emit(type: string, event: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }
}

class FakeURL extends URL {
  static createObjectURL = vi.fn(() => "blob:voice-test");
  static revokeObjectURL = vi.fn();
}

function installBrowserVoiceGlobals(params?: {
  getUserMedia?: () => Promise<FakeMediaStream>;
}) {
  Object.defineProperty(globalThis.navigator, "mediaDevices", {
    configurable: true,
    value: {
      getUserMedia:
        params?.getUserMedia ??
        vi.fn(async () => {
          return new FakeMediaStream();
        }),
    },
  });
  vi.stubGlobal("AudioContext", FakeAudioContext);
  vi.stubGlobal("AudioWorkletNode", FakeAudioWorkletNode);
  vi.stubGlobal("WebSocket", FakeWebSocket);
  Object.defineProperty(globalThis.URL, "createObjectURL", {
    configurable: true,
    value: FakeURL.createObjectURL,
  });
  Object.defineProperty(globalThis.URL, "revokeObjectURL", {
    configurable: true,
    value: FakeURL.revokeObjectURL,
  });
}

function createBootstrapResponse(overrides: Record<string, unknown> = {}) {
  return {
    ticket: "voice-ticket",
    sessionKey: "voice:browser:1",
    provider: "openai-realtime",
    modelId: "gpt-4o-realtime-preview",
    transport: {
      wsPath: "/voice/ws",
      sampleRateHz: 24000,
      channels: 1,
      frameDurationMs: 20,
    },
    ...overrides,
  };
}

function createHost(overrides: Record<string, unknown> = {}) {
  return {
    settings: { gatewayUrl: "http://127.0.0.1:18789" },
    password: "",
    client: {
      request: vi.fn(async () => createBootstrapResponse()),
    },
    connected: true,
    sessionKey: "main",
    assistantAgentId: null,
    chatLoading: false,
    chatMessages: [],
    chatThinkingLevel: null,
    chatStream: null,
    chatStreamStartedAt: null,
    lastError: null,
    voiceSupported: false,
    voiceAvailable: true,
    voiceAvailabilityReason: null,
    voiceConfigLoading: false,
    voiceConfigProvider: null,
    voiceDeprecations: [],
    voiceConnecting: false,
    voiceConnected: false,
    voiceStatus: null,
    voiceError: null,
    voiceLiveUserTurn: null,
    voiceLiveAssistantTurn: null,
    voiceSessionKey: null,
    voiceProvider: null,
    voiceVolume: 0,
    voiceHandle: null,
    requestUpdate: vi.fn(),
    ...overrides,
  };
}

beforeEach(() => {
  wsInstances.length = 0;
  workletInstances.length = 0;
  playbackSampleRates.length = 0;
  chatMocks.loadChatHistory.mockReset();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("refreshVoiceConfig", () => {
  it("caches browser voice availability, provider, and deprecations", async () => {
    const host = createHost({
      client: {
        request: vi.fn(async () => ({
          config: {
            voice: {
              provider: "openai-realtime",
              resolved: { provider: "openai-realtime" },
              browser: {
                enabled: true,
                channels: 1,
                vad: "provider",
              },
              session: {
                sharedChatHistory: true,
              },
              deprecations: ["plugins.entries.voice-call.config is deprecated"],
            },
          },
        })),
      },
    });

    await refreshVoiceConfig(host as never);

    expect(host.voiceAvailable).toBe(true);
    expect(host.voiceAvailabilityReason).toBeNull();
    expect(host.voiceConfigProvider).toBe("openai-realtime");
    expect(host.voiceDeprecations).toEqual(["plugins.entries.voice-call.config is deprecated"]);
    expect(host.voiceConfigLoading).toBe(false);
  });

  it("stores the exact browser voice unavailability reason from voice.config", async () => {
    const host = createHost({
      client: {
        request: vi.fn(async () => ({
          config: {
            voice: {
              provider: "openai-realtime",
              browser: {
                enabled: false,
              },
              deprecations: ["legacy warning"],
            },
          },
        })),
      },
    });

    await refreshVoiceConfig(host as never);

    expect(host.voiceAvailable).toBe(false);
    expect(host.voiceAvailabilityReason).toBe("Browser voice is disabled in the current gateway config.");
    expect(host.voiceConfigProvider).toBe("openai-realtime");
    expect(host.voiceDeprecations).toEqual(["legacy warning"]);
    expect(host.voiceConfigLoading).toBe(false);
  });
});

describe("handleVoiceConnect", () => {
  it("bootstraps browser voice with a ticket, updates transcripts, and refreshes shared history", async () => {
    installBrowserVoiceGlobals();
    const host = createHost();

    await handleVoiceConnect(host as never);

    expect(host.client.request).toHaveBeenCalledWith("voice.session.create", {
      sessionKey: "main",
    });
    expect(wsInstances).toHaveLength(1);
    const ws = wsInstances[0];
    expect(ws?.url).toBe("ws://127.0.0.1:18789/voice/ws");

    ws?.emitOpen();
    expect(ws?.sent).toHaveLength(1);
    expect(JSON.parse(ws?.sent[0] as string)).toEqual({ type: "start", ticket: "voice-ticket" });

    ws?.emitMessage(
      JSON.stringify({
        type: "ready",
        sessionKey: "voice:browser:1",
        provider: "openai-realtime",
        modelId: "gpt-4o-realtime-preview",
        transport: {
          sampleRateHz: 24000,
        },
      }),
    );
    expect(host.voiceConnecting).toBe(false);
    expect(host.voiceConnected).toBe(true);
    expect(host.voiceProvider).toBe("openai-realtime");
    expect(host.voiceSessionKey).toBe("voice:browser:1");

    ws?.emitMessage(JSON.stringify({ type: "transcript", role: "user", text: "Good", final: false }));
    expect(host.voiceLiveUserTurn).toMatchObject({ text: "Good", final: false });
    ws?.emitMessage(JSON.stringify({ type: "transcript", role: "user", text: " morning", final: false }));
    expect(host.voiceLiveUserTurn).toMatchObject({ text: "Good morning", final: false });
    ws?.emitMessage(JSON.stringify({ type: "transcript", role: "user", text: "good morning", final: true }));
    ws?.emitMessage(
      JSON.stringify({ type: "transcript", role: "assistant", text: "Hi", final: false }),
    );
    expect(host.voiceLiveAssistantTurn).toMatchObject({ text: "Hi", final: false });
    ws?.emitMessage(
      JSON.stringify({ type: "transcript", role: "assistant", text: " there", final: false }),
    );
    expect(host.voiceLiveAssistantTurn).toMatchObject({ text: "Hi there", final: false });
    ws?.emitMessage(
      JSON.stringify({ type: "transcript", role: "assistant", text: "hi there", final: true }),
    );
    vi.advanceTimersByTime(181);
    await Promise.resolve();

    expect(host.voiceLiveUserTurn).toMatchObject({ text: "good morning", final: true });
    expect(host.voiceLiveAssistantTurn).toMatchObject({ text: "hi there", final: true });
    expect(host.requestUpdate).toHaveBeenCalled();
    expect(chatMocks.loadChatHistory).toHaveBeenCalledTimes(1);
    expect(chatMocks.loadChatHistory).toHaveBeenNthCalledWith(1, host, { sessionKey: "voice:browser:1" });

    handleVoiceInterrupt(host as never);
    expect(
      ws?.sent.some((entry) => typeof entry === "string" && JSON.parse(entry).type === "interrupt"),
    ).toBe(true);

    ws?.emitMessage(JSON.stringify({ type: "tool_result", name: "session_status" }));
    vi.advanceTimersByTime(181);
    await vi.waitFor(() => {
      expect(chatMocks.loadChatHistory).toHaveBeenCalledTimes(2);
    });
    expect(chatMocks.loadChatHistory).toHaveBeenNthCalledWith(2, host, { sessionKey: "voice:browser:1" });

    await handleVoiceDisconnect(host as never);
    expect(host.voiceConnected).toBe(false);
    expect(host.voiceHandle).toBeNull();
    expect(ws?.readyState).toBe(FakeWebSocket.CLOSED);
  });

  it("uses ready transport sample rate for playback instead of the bootstrap fallback", async () => {
    installBrowserVoiceGlobals();
    const host = createHost({
      client: {
        request: vi.fn(async () =>
          createBootstrapResponse({
            transport: {
              wsPath: "/voice/ws",
              sampleRateHz: 16000,
              channels: 1,
              frameDurationMs: 20,
            },
          }),
        ),
      },
    });

    await handleVoiceConnect(host as never);
    const ws = wsInstances[0];
    ws?.emitOpen();
    ws?.emitMessage(
      JSON.stringify({
        type: "ready",
        sessionKey: "voice:browser:1",
        provider: "openai-realtime",
        transport: {
          sampleRateHz: 24000,
        },
      }),
    );
    ws?.emitMessage(new Int16Array([1, 2, 3, 4]).buffer);

    expect(playbackSampleRates).toContain(24000);
    expect(playbackSampleRates).not.toContain(16000);
  });

  it("coalesces overlapping history refreshes and clears finalized live turns after persistence", async () => {
    installBrowserVoiceGlobals();
    let releaseRefresh: (() => void) | null = null;
    chatMocks.loadChatHistory.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          releaseRefresh = () => {
            resolve();
          };
        }),
    );
    const host = createHost();

    await handleVoiceConnect(host as never);
    const ws = wsInstances[0];
    ws?.emitOpen();
    ws?.emitMessage(
      JSON.stringify({
        type: "ready",
        sessionKey: "voice:browser:1",
        provider: "openai-realtime",
        transport: {
          sampleRateHz: 24000,
        },
      }),
    );

    ws?.emitMessage(JSON.stringify({ type: "transcript", role: "user", text: "hello", final: true }));
    vi.advanceTimersByTime(181);
    await Promise.resolve();
    expect(chatMocks.loadChatHistory).toHaveBeenCalledTimes(1);

    ws?.emitMessage(JSON.stringify({ type: "transcript", role: "assistant", text: "hi", final: true }));
    vi.advanceTimersByTime(181);
    await Promise.resolve();
    expect(chatMocks.loadChatHistory).toHaveBeenCalledTimes(1);

    host.chatMessages = [
      { role: "user", content: [{ type: "text", text: "hello" }] },
      { role: "assistant", content: [{ type: "text", text: "hi" }] },
    ];
    releaseRefresh?.();
    await vi.waitFor(() => {
      expect(chatMocks.loadChatHistory).toHaveBeenCalledTimes(2);
    });
    expect(host.voiceLiveUserTurn).toBeNull();
    expect(host.voiceLiveAssistantTurn).toBeNull();
  });

  it("boots the voice session before requesting microphone access", async () => {
    const getUserMedia = vi.fn(async () => new FakeMediaStream());
    installBrowserVoiceGlobals({ getUserMedia });
    const host = createHost({
      client: {
        request: vi.fn(async () => {
          throw new Error("voice bootstrap failed");
        }),
      },
    });

    await handleVoiceConnect(host as never);

    expect(host.client.request).toHaveBeenCalledWith("voice.session.create", {
      sessionKey: "main",
    });
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(host.voiceError).toBe("voice bootstrap failed");
    expect(wsInstances).toHaveLength(0);
  });

  it("blocks connect when browser voice is unavailable", async () => {
    const getUserMedia = vi.fn(async () => new FakeMediaStream());
    installBrowserVoiceGlobals({ getUserMedia });
    const host = createHost({
      voiceAvailable: false,
      voiceAvailabilityReason: "Browser voice is disabled in the current gateway config.",
    });

    await handleVoiceConnect(host as never);

    expect(host.voiceError).toBe("Browser voice is disabled in the current gateway config.");
    expect(host.client.request).not.toHaveBeenCalled();
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(wsInstances).toHaveLength(0);
  });

  it("merges bootstrap deprecations into the cached voice warnings", async () => {
    installBrowserVoiceGlobals();
    const host = createHost({
      voiceDeprecations: ["gateway warning"],
      client: {
        request: vi.fn(async () =>
          createBootstrapResponse({
            deprecations: ["bootstrap warning"],
          }),
        ),
      },
    });

    await handleVoiceConnect(host as never);

    expect(host.voiceDeprecations).toEqual(["gateway warning", "bootstrap warning"]);
  });

  it("surfaces microphone permission failures", async () => {
    installBrowserVoiceGlobals({
      getUserMedia: vi.fn(async () => {
        throw new Error("Permission denied");
      }),
    });
    const host = createHost();

    await handleVoiceConnect(host as never);

    expect(host.voiceError).toBe("Permission denied");
    expect(host.voiceConnecting).toBe(false);
    expect(wsInstances).toHaveLength(0);
  });

  it("preserves timeout errors across normal websocket teardown", async () => {
    installBrowserVoiceGlobals();
    const host = createHost();

    await handleVoiceConnect(host as never);
    const ws = wsInstances[0];
    ws?.emitOpen();
    ws?.emitMessage(
      JSON.stringify({
        type: "ready",
        sessionKey: "voice:browser:1",
        provider: "openai-realtime",
      }),
    );

    ws?.emitMessage(JSON.stringify({ type: "error", message: "voice session timeout" }));
    ws?.close(1000, "voice session timeout");
    await Promise.resolve();
    await Promise.resolve();

    expect(host.voiceError).toBe("voice session timeout");
    expect(host.voiceConnected).toBe(false);
    expect(host.voiceHandle).toBeNull();
  });

  it("surfaces websocket transport errors", async () => {
    installBrowserVoiceGlobals();
    const host = createHost();

    await handleVoiceConnect(host as never);
    const ws = wsInstances[0];
    ws?.emitOpen();
    ws?.emitError();

    expect(host.voiceError).toBe("Voice transport error");

    await handleVoiceDisconnect(host as never, { preserveError: true });
    expect(host.voiceError).toBe("Voice transport error");
  });
});

describe("voice debug logging", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("stays silent without the browser debug gate", async () => {
    installBrowserVoiceGlobals();
    const consoleDebug = vi.spyOn(console, "debug").mockImplementation(() => undefined);
    const host = createHost();

    await refreshVoiceConfig(host as never);

    expect(consoleDebug).not.toHaveBeenCalled();
  });

  it("logs lifecycle events in metadata mode without payload dumps", async () => {
    installBrowserVoiceGlobals();
    window.localStorage.setItem("openclaw.debug.voice", "1");
    const consoleDebug = vi.spyOn(console, "debug").mockImplementation(() => undefined);
    const host = createHost();

    await handleVoiceConnect(host as never);
    const ws = wsInstances[0];
    ws?.emitOpen();
    ws?.emitMessage(
      JSON.stringify({
        type: "ready",
        sessionKey: "voice:browser:1",
        provider: "openai-realtime",
      }),
    );
    ws?.emitMessage(
      JSON.stringify({
        type: "transcript",
        role: "assistant",
        text: "Hi there",
        final: false,
      }),
    );

    const messages = consoleDebug.mock.calls.map(([message]) => String(message));
    expect(messages.some((message) => message.includes("voice bootstrap request"))).toBe(true);
    expect(messages.some((message) => message.includes("voice websocket send"))).toBe(true);
    expect(messages.some((message) => message.includes("voice websocket receive"))).toBe(true);
    expect(messages.some((message) => message.includes("voice transcript update applied"))).toBe(true);
    expect(messages.some((message) => message.includes("payload"))).toBe(false);
  });

  it("logs capture stats and warns when no transcript frames arrive after audio upload", async () => {
    installBrowserVoiceGlobals();
    window.localStorage.setItem("openclaw.debug.voice", "1");
    const consoleDebug = vi.spyOn(console, "debug").mockImplementation(() => undefined);
    const host = createHost();

    await handleVoiceConnect(host as never);
    const ws = wsInstances[0];
    ws?.emitOpen();
    ws?.emitMessage(
      JSON.stringify({
        type: "ready",
        sessionKey: "voice:browser:1",
        provider: "openai-realtime",
      }),
    );

    const pcm = Int16Array.from(new Array(320).fill(4096));
    workletInstances[0]?.emitVolume(0.02);
    workletInstances[0]?.emitAudioFrame(pcm.buffer.slice(0));
    vi.advanceTimersByTime(5001);

    const messages = consoleDebug.mock.calls.map(([message]) => String(message));
    expect(messages.some((message) => message.includes("voice capture stats"))).toBe(true);
    expect(messages.some((message) => message.includes("voice capture audio frame"))).toBe(true);
    expect(messages.some((message) => message.includes("voice transcript warning"))).toBe(true);
  });
  it("emits payload dumps only when browser payload mode is enabled", async () => {
    installBrowserVoiceGlobals();
    window.localStorage.setItem("openclaw.debug.voice", "1");
    window.localStorage.setItem("openclaw.debug.voice.payloads", "1");
    const consoleDebug = vi.spyOn(console, "debug").mockImplementation(() => undefined);
    const host = createHost();

    await handleVoiceConnect(host as never);
    const ws = wsInstances[0];
    ws?.emitOpen();
    ws?.emitMessage(
      JSON.stringify({
        type: "ready",
        sessionKey: "voice:browser:1",
        provider: "openai-realtime",
      }),
    );
    ws?.emitMessage(
      JSON.stringify({
        type: "transcript",
        role: "user",
        text: "Hello",
        final: false,
      }),
    );

    const messages = consoleDebug.mock.calls.map(([message]) => String(message));
    expect(messages.some((message) => message.includes("voice bootstrap response payload"))).toBe(true);
    expect(messages.some((message) => message.includes("voice websocket send payload"))).toBe(true);
    expect(messages.some((message) => message.includes("voice websocket receive payload"))).toBe(true);
    expect(messages.some((message) => message.includes("voice transcript update payload"))).toBe(true);
  });
});




