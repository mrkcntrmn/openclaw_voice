import { describe, expect, it } from "vitest";
import { mountApp, registerAppMountHooks } from "./test-helpers/app-mount.ts";

registerAppMountHooks();

describe("voice panel app wiring", () => {
  it("renders live voice state from app view state", async () => {
    const app = mountApp("/chat");
    await app.updateComplete;

    app.connected = true;
    app.voiceSupported = true;
    app.voiceAvailable = true;
    app.voiceConfigProvider = "config-provider";
    app.voiceProvider = "live-provider";
    app.voiceConnected = true;
    app.voiceStatus = "Listening";
    app.voiceLiveUserTurn = {
      text: "Testing one two",
      final: false,
      startedAt: 1000,
      updatedAt: 1001,
    };
    app.voiceLiveAssistantTurn = {
      text: "I can hear you.",
      final: false,
      startedAt: 1002,
      updatedAt: 1003,
    };
    app.voiceVolume = 0.42;

    await app.updateComplete;

    const provider = app.querySelector(".voice-panel__provider");
    expect(provider?.textContent?.trim()).toBe("live-provider");

    expect(app.querySelector(".voice-panel__text")).toBeNull();
    const chatBubbles = Array.from(app.querySelectorAll<HTMLElement>(".chat-bubble.voice-live"));
    expect(chatBubbles[0]?.textContent).toContain("Testing one two");
    expect(chatBubbles[1]?.textContent).toContain("I can hear you.");

    const indicator = app.querySelector("voice-activity-indicator") as { volume?: number } | null;
    expect(indicator?.volume).toBe(0.42);
  });
});
