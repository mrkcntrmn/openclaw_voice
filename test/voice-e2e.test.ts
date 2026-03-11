import { describe, it, expect } from "vitest";
import { 
  validateVoiceWsServerFrame,
  type VoiceWsServerFrame 
} from "../src/gateway/protocol/index.js";

// Mocking some of the gateway internals would be complex here, 
// but I can use the existing server-voice.test.ts logic to perform a "live" test
// against a temporary gateway instance if needed.
// However, since I already updated server-voice.test.ts and it passes, 
// I'll focus on a test that simulates the CLIENT side behavior more closely.

describe("Voice E2E Flow Simulation", () => {
  // This test relies on the fact that server-voice.ts is already tested.
  // Here we just verify that our protocol definitions and validation work for a full sequence.

  it("validates a full server-to-client sequence", () => {
    const sequence: VoiceWsServerFrame[] = [
      { type: "ready", sessionKey: "test", provider: "openai", modelId: "gpt-4o-realtime" },
      { type: "state", state: "listening" },
      { type: "transcript", role: "user", text: "hello", final: true },
      { type: "state", state: "responding", detail: "thinking" },
      { type: "transcript", role: "assistant", text: "Hi there!", final: false },
      { type: "transcript", role: "assistant", text: "Hi there! How can I help?", final: true },
      { type: "state", state: "listening" },
    ];

    for (const frame of sequence) {
      const ok = validateVoiceWsServerFrame(frame);
      if (!ok) {
        console.error(validateVoiceWsServerFrame.errors);
      }
      expect(ok).toBe(true);
    }
  });
});
