import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { CURRENT_SESSION_VERSION, SessionManager } from "@mariozechner/pi-coding-agent";
import { resolveDefaultAgentId } from "../agents/agent-scope.js";
import { loadConfig } from "../config/config.js";
import {
  loadSessionStore,
  resolveStorePath,
  resolveSessionFilePath,
  saveSessionStore,
  type SessionEntry,
} from "../config/sessions.js";
import { emitSessionTranscriptUpdate } from "../sessions/transcript-events.js";
import { loadSessionEntry, readSessionMessages } from "../gateway/session-utils.js";

export type VoiceTranscriptRole = "user" | "assistant";

export type VoiceHistoryTurn = {
  role: VoiceTranscriptRole;
  text: string;
  timestamp?: number;
};

function ensureSessionHeader(sessionFile: string, sessionId: string): void {
  if (fs.existsSync(sessionFile)) {
    return;
  }
  fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
  const header = {
    type: "session",
    version: CURRENT_SESSION_VERSION,
    id: sessionId,
    timestamp: new Date().toISOString(),
    cwd: process.cwd(),
  };
  fs.writeFileSync(sessionFile, `${JSON.stringify(header)}\n`, {
    encoding: "utf-8",
    mode: 0o600,
  });
}

function extractMessageText(message: unknown): string | null {
  if (!message || typeof message !== "object") {
    return null;
  }
  const entry = message as { text?: unknown; content?: unknown };
  if (typeof entry.text === "string" && entry.text.trim()) {
    return entry.text.trim();
  }
  if (typeof entry.content === "string" && entry.content.trim()) {
    return entry.content.trim();
  }
  if (!Array.isArray(entry.content)) {
    return null;
  }
  const text = entry.content
    .map((block) => {
      if (!block || typeof block !== "object") {
        return null;
      }
      const typed = block as { type?: unknown; text?: unknown };
      return typed.type === "text" && typeof typed.text === "string" ? typed.text : null;
    })
    .filter((value): value is string => Boolean(value))
    .join("\n")
    .trim();
  return text || null;
}

function resolveOrCreateSessionEntry(params: {
  sessionKey: string;
  agentId: string;
}): {
  storePath: string;
  entry: SessionEntry;
} {
  const cfg = loadConfig();
  const storePath = resolveStorePath(cfg.session?.store, { agentId: params.agentId });
  const store = loadSessionStore(storePath);
  const existing = store[params.sessionKey];
  if (existing?.sessionId) {
    return { storePath, entry: existing };
  }
  const entry: SessionEntry = {
    sessionId: crypto.randomUUID(),
    updatedAt: Date.now(),
  };
  store[params.sessionKey] = entry;
  void saveSessionStore(storePath, store);
  return { storePath, entry };
}

export async function appendVoiceTranscriptMessage(params: {
  sessionKey: string;
  role: VoiceTranscriptRole;
  text: string;
  providerId: string;
  modelId?: string;
  agentId?: string;
}): Promise<void> {
  const text = params.text.trim();
  if (!text) {
    return;
  }
  const cfg = loadConfig();
  const agentId = params.agentId ?? resolveDefaultAgentId(cfg);
  const { entry: loadedEntry, storePath: loadedStorePath } = loadSessionEntry(params.sessionKey);
  const resolved = loadedEntry?.sessionId
    ? { entry: loadedEntry, storePath: loadedStorePath }
    : resolveOrCreateSessionEntry({ sessionKey: params.sessionKey, agentId });
  const sessionFile = resolveSessionFilePath(resolved.entry.sessionId, resolved.entry, { agentId });
  ensureSessionHeader(sessionFile, resolved.entry.sessionId);

  const sessionManager = SessionManager.open(sessionFile);
  sessionManager.appendMessage({
    role: params.role,
    content: [{ type: "text", text }],
    api: "openai-responses",
    provider: params.providerId,
    model: params.modelId ?? "voice-gateway",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0,
      },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  });
  emitSessionTranscriptUpdate(sessionFile);
}

export function loadVoiceConversationHistory(params: {
  sessionKey: string;
  limit?: number;
}): VoiceHistoryTurn[] {
  const { entry, storePath } = loadSessionEntry(params.sessionKey);
  if (!entry?.sessionId || !storePath) {
    return [];
  }
  const history = readSessionMessages(entry.sessionId, storePath, entry.sessionFile);
  const turns: VoiceHistoryTurn[] = [];
  for (const message of history) {
    if (!message || typeof message !== "object") {
      continue;
    }
    const roleRaw = (message as { role?: unknown }).role;
    const role = roleRaw === "user" || roleRaw === "assistant" ? roleRaw : null;
    if (!role) {
      continue;
    }
    const text = extractMessageText(message);
    if (!text) {
      continue;
    }
    turns.push({
      role,
      text,
      timestamp:
        typeof (message as { timestamp?: unknown }).timestamp === "number"
          ? ((message as { timestamp?: number }).timestamp ?? undefined)
          : undefined,
    });
  }
  const limit = typeof params.limit === "number" && params.limit > 0 ? params.limit : 24;
  return turns.length > limit ? turns.slice(-limit) : turns;
}