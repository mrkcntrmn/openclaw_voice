import fs from "node:fs/promises";
import path from "node:path";
import { EventEmitter } from "node:events";
import WebSocket from "ws";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  connectReq,
  installGatewayTestHooks,
  onceMessage,
  rpcReq,
  startConnectedServerWithClient,
  trackConnectChallengeNonce,
} from "./test-helpers.js";

const debugState = vi.hoisted(() => ({
  debugCalls: [] as Array<{ subsystem: string; message: string; meta?: Record<string, unknown> }>,
  payloadCalls: [] as Array<{
    subsystem: string;
    message: string;
    payload: unknown;
    meta?: Record<string, unknown>;
  }>,
}));

const runtimeState = vi.hoisted(() => ({
  runtimes: [] as Array<{
    orchestrator: EventEmitter & {
      audioFrames: Buffer[];
      texts: string[];
      sendAudio: (audio: Buffer) => void;
      sendText: (text: string) => void;
      interrupt: () => void;
      close: () => void;
    };
  }>,
}));

vi.mock("../voice/debug.js", () => ({
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
  voiceDebugElapsedMs: () => 4,
}));

vi.mock("../voice/runtime.js", () => ({
  resolveVoiceSessionConfig: vi.fn(async () => ({
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
      authTimeoutMs: 10000,
    },
    session: {
      interruptOnSpeech: true,
      pauseOnToolCall: true,
      persistTranscripts: true,
      sharedChatHistory: true,
      transcriptSource: "provider" as const,
      sessionKeyPrefix: "voice",
    },
    deployment: {
      websocket: {},
    },
  })),
  createVoiceSessionRuntime: vi.fn(async () => {
    const orchestrator = new EventEmitter() as EventEmitter & {
      audioFrames: Buffer[];
      texts: string[];
      sendAudio: (audio: Buffer) => void;
      sendText: (text: string) => void;
      interrupt: () => void;
      close: () => void;
    };
    orchestrator.audioFrames = [];
    orchestrator.texts = [];
    orchestrator.sendAudio = (audio: Buffer) => {
      orchestrator.audioFrames.push(audio);
    };
    orchestrator.sendText = (text: string) => {
      orchestrator.texts.push(text);
    };
    orchestrator.interrupt = () => {
      orchestrator.emit("state", { state: "listening", detail: "interrupt" });
    };
    orchestrator.close = () => {
      orchestrator.emit("state", { state: "closed" });
    };
    runtimeState.runtimes.push({ orchestrator });
    return {
      resolved: {
        providerId: "openai-realtime",
        modelId: "gpt-4o-realtime-preview",
        browser: {
          sampleRateHz: 16000,
          channels: 1,
          frameDurationMs: 20,
        },
        deployment: {
          websocket: {},
        },
      },
      orchestrator,
      connect: async () => {
        orchestrator.emit("state", { state: "connected" });
      },
    };
  }),
}));

installGatewayTestHooks({ scope: "suite" });

let startedServer: Awaited<ReturnType<typeof startConnectedServerWithClient>>;

async function writeVoiceConfig(): Promise<void> {
  const configPath = process.env.OPENCLAW_CONFIG_PATH;
  if (!configPath) {
    throw new Error("OPENCLAW_CONFIG_PATH is not set for gateway tests");
  }
  const config = {
    voice: {
      provider: "openai-realtime",
      providers: {
        "openai-realtime": {
          apiKey: "test-api-key",
          modelId: "gpt-4o-realtime-preview",
        },
      },
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
        sharedChatHistory: true,
        transcriptSource: "provider",
        sessionKeyPrefix: "voice",
      },
    },
  };

  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, JSON.stringify(config, null, 2), "utf-8");
}

async function waitForOpen(ws: WebSocket): Promise<void> {
  if (ws.readyState === WebSocket.OPEN) {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout waiting for websocket open")), 10000);
    const cleanup = () => {
      clearTimeout(timer);
      ws.off("open", onOpen);
      ws.off("error", onError);
    };
    const onOpen = () => {
      cleanup();
      resolve();
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    ws.once("open", onOpen);
    ws.once("error", onError);
  });
}

async function openGatewayWs(port: number): Promise<WebSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  trackConnectChallengeNonce(ws);
  await waitForOpen(ws);
  return ws;
}

async function openVoiceWs(port: number): Promise<WebSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/voice/ws`);
  await waitForOpen(ws);
  return ws;
}

beforeAll(async () => {
  startedServer = await startConnectedServerWithClient();
});

beforeEach(async () => {
  debugState.debugCalls.length = 0;
  debugState.payloadCalls.length = 0;
  runtimeState.runtimes.length = 0;
  delete process.env.OPENCLAW_DEBUG_VOICE;
  delete process.env.OPENCLAW_DEBUG_VOICE_PAYLOADS;
  delete process.env.OPENCLAW_DEBUG_VOICE_AUDIO_DUMP;
  await writeVoiceConfig();
});

afterAll(async () => {
  startedServer.ws.close();
  await startedServer.server.close();
});

describe("gateway voice debug logging", () => {
  it("logs websocket lifecycle, start frames, audio receipt, and relay frames in metadata mode", async () => {
    process.env.OPENCLAW_DEBUG_VOICE = "1";

    const gatewayWs = await openGatewayWs(startedServer.port);
    const connect = await connectReq(gatewayWs, { scopes: ["operator.read"] });
    expect(connect.ok).toBe(true);

    const bootstrap = await rpcReq<{ ticket?: string }>(gatewayWs, "voice.session.create", {
      sessionKey: "voice:test-debug",
    });
    expect(bootstrap.ok).toBe(true);

    const voiceWs = await openVoiceWs(startedServer.port);
    try {
      voiceWs.send(JSON.stringify({ type: "start", ticket: bootstrap.payload?.ticket }));
      await onceMessage(voiceWs, (message) => message.type === "ready");
      voiceWs.send(Buffer.from(Int16Array.from(new Array(320).fill(1024)).buffer));
      const runtime = runtimeState.runtimes[0];
      runtime?.orchestrator.emit("transcript", {
        role: "assistant",
        text: "hello there",
        final: true,
      });
      await onceMessage(voiceWs, (message) => message.type === "transcript");

      await vi.waitFor(() => {
        expect(runtime?.orchestrator.audioFrames).toHaveLength(1);
        expect(debugState.debugCalls).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ subsystem: "gateway/voice", message: "voice bootstrap request" }),
            expect.objectContaining({ subsystem: "gateway/voice", message: "voice bootstrap response" }),
            expect.objectContaining({ subsystem: "gateway/voice", message: "voice websocket open" }),
            expect.objectContaining({ subsystem: "gateway/voice", message: "voice start frame received" }),
            expect.objectContaining({ subsystem: "gateway/voice", message: "voice runtime connect start" }),
            expect.objectContaining({ subsystem: "gateway/voice", message: "voice websocket receive" }),
            expect.objectContaining({ subsystem: "gateway/voice", message: "voice audio metrics" }),
            expect.objectContaining({ subsystem: "gateway/voice", message: "voice relay frame" }),
          ]),
        );
      });
      expect(debugState.payloadCalls).toEqual([]);
    } finally {
      gatewayWs.close();
      voiceWs.close();
    }
  });

  it("writes an audio dump only when audio dump mode is enabled", async () => {
    process.env.OPENCLAW_DEBUG_VOICE = "1";
    process.env.OPENCLAW_DEBUG_VOICE_AUDIO_DUMP = "1";

    const gatewayWs = await openGatewayWs(startedServer.port);
    const connect = await connectReq(gatewayWs, { scopes: ["operator.read"] });
    expect(connect.ok).toBe(true);

    const bootstrap = await rpcReq<{ ticket?: string }>(gatewayWs, "voice.session.create", {
      sessionKey: "voice:test-debug-dump",
    });
    expect(bootstrap.ok).toBe(true);

    const voiceWs = await openVoiceWs(startedServer.port);
    let dumpPath: string | undefined;
    try {
      voiceWs.send(JSON.stringify({ type: "start", ticket: bootstrap.payload?.ticket }));
      await onceMessage(voiceWs, (message) => message.type === "ready");
      voiceWs.send(Buffer.from(Int16Array.from(new Array(320).fill(2048)).buffer));
      voiceWs.close(1000, "done");

      await vi.waitFor(() => {
        const dumpLog = debugState.debugCalls.find(
          (entry) => entry.subsystem === "gateway/voice" && entry.message === "voice audio dump",
        );
        expect(dumpLog?.meta?.dumpPath).toBeTruthy();
        dumpPath = String(dumpLog?.meta?.dumpPath);
      });

      const stat = await fs.stat(dumpPath!);
      expect(stat.size).toBeGreaterThan(44);
    } finally {
      if (dumpPath) {
        await fs.rm(dumpPath, { force: true });
      }
      gatewayWs.close();
      voiceWs.close();
    }
  });
  it("logs payload dumps only when payload mode is enabled", async () => {
    process.env.OPENCLAW_DEBUG_VOICE = "1";
    process.env.OPENCLAW_DEBUG_VOICE_PAYLOADS = "1";

    const gatewayWs = await openGatewayWs(startedServer.port);
    const connect = await connectReq(gatewayWs, { scopes: ["operator.read"] });
    expect(connect.ok).toBe(true);

    const bootstrap = await rpcReq<{ ticket?: string }>(gatewayWs, "voice.session.create", {
      sessionKey: "voice:test-debug-payload",
    });
    expect(bootstrap.ok).toBe(true);

    const voiceWs = await openVoiceWs(startedServer.port);
    try {
      voiceWs.send(JSON.stringify({ type: "start", ticket: bootstrap.payload?.ticket }));
      await onceMessage(voiceWs, (message) => message.type === "ready");
      voiceWs.send(JSON.stringify({ type: "text", text: "hello browser" }));
      const runtime = runtimeState.runtimes[0];
      runtime?.orchestrator.emit("tool_result", {
        callId: "call-1",
        name: "lookup",
        output: "done",
      });
      await onceMessage(voiceWs, (message) => message.type === "tool_result");

      expect(debugState.payloadCalls).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ subsystem: "gateway/voice", message: "voice bootstrap request payload" }),
          expect.objectContaining({ subsystem: "gateway/voice", message: "voice bootstrap response payload" }),
          expect.objectContaining({ subsystem: "gateway/voice", message: "voice websocket receive payload" }),
          expect.objectContaining({ subsystem: "gateway/voice", message: "voice relay frame payload" }),
        ]),
      );
    } finally {
      gatewayWs.close();
      voiceWs.close();
    }
  });
});

