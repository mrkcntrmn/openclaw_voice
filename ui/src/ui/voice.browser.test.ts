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
    app.voiceUserTranscript = "Testing one two";
    app.voiceAssistantTranscript = "I can hear you.";
    app.voiceVolume = 0.42;

    await app.updateComplete;

    const provider = app.querySelector(".voice-panel__provider");
    expect(provider?.textContent?.trim()).toBe("live-provider");

    const transcriptNodes = Array.from(app.querySelectorAll<HTMLElement>(".voice-panel__text"));
    expect(transcriptNodes[0]?.textContent?.trim()).toBe("Testing one two");
    expect(transcriptNodes[1]?.textContent?.trim()).toBe("I can hear you.");

    const indicator = app.querySelector("voice-activity-indicator") as { volume?: number } | null;
    expect(indicator?.volume).toBe(0.42);
  });
});
