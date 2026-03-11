import { randomUUID } from "node:crypto";
import type { OpenClawConfig } from "../config/config.js";
import type { VoiceConfig } from "../config/types.gateway.js";

const MIN_TICKET_TTL_MS = 5_000;
const DEFAULT_TICKET_TTL_MS = 60_000;

export type VoiceSessionTicketPayload = {
  cfg: OpenClawConfig;
  voice: VoiceConfig;
  providerId: string;
  modelId: string;
  sessionKey: string;
  agentId?: string;
  instructions?: string;
};

export type VoiceSessionTicketIssueResult = {
  ticket: string;
  expiresAt: number;
};

export type VoiceSessionTicketStore = {
  issue: (
    payload: VoiceSessionTicketPayload,
    opts?: { ttlMs?: number },
  ) => VoiceSessionTicketIssueResult;
  consume: (ticket: string) => VoiceSessionTicketPayload | null;
  clear: () => void;
};

function normalizeTtlMs(ttlMs: number | undefined, fallbackTtlMs: number): number {
  if (typeof ttlMs !== "number" || !Number.isFinite(ttlMs)) {
    return fallbackTtlMs;
  }
  return Math.max(MIN_TICKET_TTL_MS, Math.round(ttlMs));
}

export function createVoiceSessionTicketStore(params?: {
  now?: () => number;
  defaultTtlMs?: number;
}): VoiceSessionTicketStore {
  const now = params?.now ?? Date.now;
  const defaultTtlMs = normalizeTtlMs(params?.defaultTtlMs, DEFAULT_TICKET_TTL_MS);
  const tickets = new Map<string, { payload: VoiceSessionTicketPayload; expiresAt: number }>();

  const purgeExpired = () => {
    const currentTime = now();
    for (const [ticket, entry] of tickets.entries()) {
      if (entry.expiresAt <= currentTime) {
        tickets.delete(ticket);
      }
    }
  };

  return {
    issue: (payload, opts) => {
      purgeExpired();
      const ttlMs = normalizeTtlMs(opts?.ttlMs, defaultTtlMs);
      const ticket = randomUUID();
      const expiresAt = now() + ttlMs;
      tickets.set(ticket, { payload, expiresAt });
      return { ticket, expiresAt };
    },
    consume: (ticket) => {
      purgeExpired();
      const entry = tickets.get(ticket);
      if (!entry) {
        return null;
      }
      tickets.delete(ticket);
      if (entry.expiresAt <= now()) {
        return null;
      }
      return entry.payload;
    },
    clear: () => {
      tickets.clear();
    },
  };
}
