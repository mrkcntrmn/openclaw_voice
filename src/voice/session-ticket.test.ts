import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { VoiceConfig } from "../config/types.gateway.js";
import { createVoiceSessionTicketStore } from "./session-ticket.js";

const TEST_PAYLOAD = {
  cfg: {} as OpenClawConfig,
  voice: { provider: "openai-realtime" } as VoiceConfig,
  providerId: "openai-realtime",
  modelId: "gpt-4o-realtime-preview",
  sessionKey: "voice:browser:test",
};

describe("createVoiceSessionTicketStore", () => {
  it("consumes a ticket only once", () => {
    const store = createVoiceSessionTicketStore({ now: () => 1_000 });
    const issued = store.issue(TEST_PAYLOAD);

    expect(store.consume(issued.ticket)).toEqual(TEST_PAYLOAD);
    expect(store.consume(issued.ticket)).toBeNull();
  });

  it("rejects expired tickets", () => {
    let now = 1_000;
    const store = createVoiceSessionTicketStore({ now: () => now, defaultTtlMs: 5_000 });
    const issued = store.issue(TEST_PAYLOAD, { ttlMs: 5_000 });

    now = issued.expiresAt + 1;
    expect(store.consume(issued.ticket)).toBeNull();
  });
});
