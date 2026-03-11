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

type MockOrchestrator = EventEmitter & {
  audioFrames: Buffer[];
  texts: string[];
  interruptCount: number;
  closeCount: number;
  sendAudio: (audio: Buffer) => void;
  sendText: (text: string) => void;
  interrupt: () => void;
  close: () => void;
};

type MockRuntimeRecord = {
  options: Record<string, unknown>;
  runtime: {
    resolved: {
      providerId: string;
      modelId: string;
      browser: {
        sampleRateHz: number;
        channels: number;
        frameDurationMs: number;
      };
    };
    orchestrator: MockOrchestrator;
    connect: () => Promise<void>;
  };
};

const runtimeMockState = vi.hoisted(() => ({
  runtimes: [] as MockRuntimeRecord[],
}));

vi.mock("../voice/runtime.js", () => {
  const resolveVoiceSessionConfig = vi.fn(async (params: {
    cfg?: { voice?: unknown };
    voice?: unknown;
    providerId?: string;
  }) => ({
    cfg: params.cfg ?? {},
    voice:
      (params.voice as Record<string, unknown> | undefined) ??
      (params.cfg?.voice as Record<string, unknown> | undefined) ??
      {},
    providerId: params.providerId ?? "openai-realtime",
    provider: { apiKey: "test-api-key" },
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
  }));

  const createVoiceSessionRuntime = vi.fn(async (options: Record<string, unknown>) => {
    const orchestrator = new EventEmitter() as MockOrchestrator;
    orchestrator.audioFrames = [];
    orchestrator.texts = [];
    orchestrator.interruptCount = 0;
    orchestrator.closeCount = 0;
    orchestrator.sendAudio = (audio: Buffer) => {
      orchestrator.audioFrames.push(audio);
    };
    orchestrator.sendText = (text: string) => {
      orchestrator.texts.push(text);
    };
    orchestrator.interrupt = () => {
      orchestrator.interruptCount += 1;
      orchestrator.emit("state", { state: "listening", detail: "interrupt" });
    };
    orchestrator.close = () => {
      orchestrator.closeCount += 1;
      orchestrator.emit("state", { state: "closed" });
    };

    const runtime = {
      resolved: {
        providerId: typeof options.providerId === "string" ? options.providerId : "openai-realtime",
        modelId:
          typeof options.modelId === "string" ? options.modelId : "gpt-4o-realtime-preview",
        browser: {
          sampleRateHz: 16000,
          channels: 1,
          frameDurationMs: 20,
        },
      },
      orchestrator,
      connect: async () => {
        orchestrator.emit("state", { state: "connected" });
      },
    };

    runtimeMockState.runtimes.push({ options, runtime });
    return runtime;
  });

  return {
    resolveVoiceSessionConfig,
    createVoiceSessionRuntime,
  };
});

installGatewayTestHooks({ scope: "suite" });

let startedServer: Awaited<ReturnType<typeof startConnectedServerWithClient>>;

async function writeVoiceConfig(extra: Record<string, unknown> = {}): Promise<void> {
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
    ...extra,
  };

  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, JSON.stringify(config, null, 2), "utf-8");
}

async function waitForWebSocketOpen(ws: WebSocket): Promise<void> {
  if (ws.readyState === WebSocket.OPEN) {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout waiting for websocket open")), 10000);
    const cleanup = () => {
      clearTimeout(timer);
      ws.off("open", onOpen);
      ws.off("error", onError);
      ws.off("close", onClose);
    };
    const onOpen = () => {
      cleanup();
      resolve();
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onClose = (code: number, reason: Buffer) => {
      cleanup();
      reject(new Error(`closed ${code}: ${reason.toString()}`));
    };
    ws.once("open", onOpen);
    ws.once("error", onError);
    ws.once("close", onClose);
  });
}

async function openGatewayWs(port: number): Promise<WebSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  trackConnectChallengeNonce(ws);
  await waitForWebSocketOpen(ws);
  return ws;
}

async function openVoiceWs(port: number): Promise<WebSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/voice/ws`);
  await waitForWebSocketOpen(ws);
  return ws;
}

async function waitForClose(ws: WebSocket): Promise<{ code: number; reason: string }> {
  if (ws.readyState === WebSocket.CLOSED) {
    return { code: 1000, reason: "" };
  }
  return await new Promise((resolve) => {
    ws.once("close", (code, reason) => {
      resolve({ code, reason: reason.toString() });
    });
  });
}

beforeAll(async () => {
  startedServer = await startConnectedServerWithClient();
});

beforeEach(async () => {
  runtimeMockState.runtimes.length = 0;
  await writeVoiceConfig();
});

afterAll(async () => {
  startedServer.ws.close();
  await startedServer.server.close();
});

describe("gateway browser voice", () => {
  it("allows read-scoped clients to create voice session tickets", async () => {
    const ws = await openGatewayWs(startedServer.port);
    try {
      const connect = await connectReq(ws, { scopes: ["operator.read"] });
      expect(connect.ok).toBe(true);

      const response = await rpcReq<{
        ticket?: string;
        sessionKey?: string;
        provider?: string;
        modelId?: string;
        transport?: { wsPath?: string; sampleRateHz?: number; frameDurationMs?: number };
      }>(ws, "voice.session.create", {
        sessionKey: "voice:test-session",
        agentId: "main",
      });

      expect(response.ok).toBe(true);
      expect(typeof response.payload?.ticket).toBe("string");
      expect(response.payload).toMatchObject({
        sessionKey: "voice:test-session",
        provider: "openai-realtime",
        modelId: "gpt-4o-realtime-preview",
        transport: {
          wsPath: "/voice/ws",
          sampleRateHz: 16000,
          frameDurationMs: 20,
        },
      });
    } finally {
      ws.close();
    }
  });

  it("rejects voice.session.create when the client is missing read scope", async () => {
    const ws = await openGatewayWs(startedServer.port);
    try {
      const connect = await connectReq(ws, { scopes: ["operator.approvals"] });
      expect(connect.ok).toBe(true);

      const response = await rpcReq(ws, "voice.session.create", {});
      expect(response.ok).toBe(false);
      expect(response.error?.message ?? "").toContain("missing scope: operator.read");
    } finally {
      ws.close();
    }
  });

  it("boots /voice/ws with a one-time ticket and routes control frames to the runtime", async () => {
    const bootstrap = await rpcReq<{
      ticket?: string;
      sessionKey?: string;
    }>(startedServer.ws, "voice.session.create", {
      sessionKey: "voice:test-session",
    });
    expect(bootstrap.ok).toBe(true);
    const ticket = bootstrap.payload?.ticket;
    expect(typeof ticket).toBe("string");

    const voiceWs = await openVoiceWs(startedServer.port);
    try {
      voiceWs.send(JSON.stringify({ type: "start", ticket }));
      const ready = await onceMessage<{
        type?: string;
        sessionKey?: string;
        provider?: string;
        modelId?: string;
      }>(voiceWs, (message) => message.type === "ready");

      expect(ready).toMatchObject({
        type: "ready",
        sessionKey: "voice:test-session",
        provider: "openai-realtime",
        modelId: "gpt-4o-realtime-preview",
      });
      expect(runtimeMockState.runtimes).toHaveLength(1);
      expect(runtimeMockState.runtimes[0]?.options).toMatchObject({
        sessionKey: "voice:test-session",
        providerId: "openai-realtime",
      });

      voiceWs.send(Buffer.from([1, 2, 3, 4]));
      voiceWs.send(JSON.stringify({ type: "text", text: "hello from the browser" }));
      const listeningState = onceMessage<{ type?: string; state?: string; detail?: string }>(
        voiceWs,
        (message) => message.type === "state" && message.state === "listening",
      );
      voiceWs.send(JSON.stringify({ type: "interrupt" }));
      await listeningState;

      const runtimeRecord = runtimeMockState.runtimes[0];
      if (!runtimeRecord) {
        throw new Error("expected a mocked voice runtime");
      }
      expect(runtimeRecord.runtime.orchestrator.audioFrames).toHaveLength(1);
      expect(runtimeRecord.runtime.orchestrator.audioFrames[0]).toEqual(Buffer.from([1, 2, 3, 4]));
      expect(runtimeRecord.runtime.orchestrator.texts).toEqual(["hello from the browser"]);
      expect(runtimeRecord.runtime.orchestrator.interruptCount).toBe(1);

      const closePromise = waitForClose(voiceWs);
      voiceWs.send(JSON.stringify({ type: "stop" }));
      const close = await closePromise;
      expect(close).toMatchObject({ code: 1000, reason: "voice stop" });
      expect(runtimeRecord.runtime.orchestrator.closeCount).toBeGreaterThanOrEqual(1);
    } finally {
      if (voiceWs.readyState === WebSocket.OPEN || voiceWs.readyState === WebSocket.CONNECTING) {
        voiceWs.close();
      }
    }
  });

  it("rejects invalid or reused voice tickets", async () => {
    const bootstrap = await rpcReq<{ ticket?: string }>(startedServer.ws, "voice.session.create", {});
    expect(bootstrap.ok).toBe(true);
    const ticket = bootstrap.payload?.ticket;
    expect(typeof ticket).toBe("string");

    const first = await openVoiceWs(startedServer.port);
    try {
      first.send(JSON.stringify({ type: "start", ticket }));
      await onceMessage(first, (message) => message.type === "ready");
    } finally {
      first.close();
      await waitForClose(first);
    }

    const second = await openVoiceWs(startedServer.port);
    try {
      const errorPromise = onceMessage<{ type?: string; message?: string }>(
        second,
        (message) => message.type === "error",
      );
      const closePromise = waitForClose(second);
      second.send(JSON.stringify({ type: "start", ticket }));

      const error = await errorPromise;
      const close = await closePromise;
      expect(error.message).toBe("voice ticket invalid or expired");
      expect(close.code).toBe(4401);
    } finally {
      if (second.readyState === WebSocket.OPEN || second.readyState === WebSocket.CONNECTING) {
        second.close();
      }
    }
  });

  it("rejects oversized audio frames after the voice session starts", async () => {
    const bootstrap = await rpcReq<{ ticket?: string }>(startedServer.ws, "voice.session.create", {});
    expect(bootstrap.ok).toBe(true);

    const voiceWs = await openVoiceWs(startedServer.port);
    try {
      voiceWs.send(JSON.stringify({ type: "start", ticket: bootstrap.payload?.ticket }));
      await onceMessage(voiceWs, (message) => message.type === "ready");

      const errorPromise = onceMessage<{ type?: string; message?: string }>(
        voiceWs,
        (message) => message.type === "error",
      );
      voiceWs.send(Buffer.alloc(128001));

      const error = await errorPromise;
      expect(error.message).toBe("audio frame too large");
    } finally {
      if (voiceWs.readyState === WebSocket.OPEN || voiceWs.readyState === WebSocket.CONNECTING) {
        voiceWs.close();
      }
    }
  });
});

