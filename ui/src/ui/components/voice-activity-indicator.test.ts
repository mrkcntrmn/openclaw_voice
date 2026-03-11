import { expect, it, describe, beforeEach } from "vitest";
import "./voice-activity-indicator.ts";
import { VoiceActivityIndicator } from "./voice-activity-indicator.ts";

describe("VoiceActivityIndicator", () => {
  let el: VoiceActivityIndicator;

  beforeEach(() => {
    el = document.createElement("voice-activity-indicator") as VoiceActivityIndicator;
    document.body.appendChild(el);
  });

  it("renders when inactive", async () => {
    expect(el.active).toBe(false);
    expect(el.volume).toBe(0);
    const bars = el.shadowRoot?.querySelectorAll(".bar");
    expect(bars?.length).toBe(5);
  });

  it("renders when active with volume", async () => {
    el.active = true;
    el.volume = 0.5;
    await new Promise((r) => setTimeout(r, 0)); // wait for lit update
    
    expect(el.active).toBe(true);
    expect(el.volume).toBe(0.5);
    const bars = el.shadowRoot?.querySelectorAll(".bar");
    expect(bars?.length).toBe(5);
    
    bars?.forEach((bar) => {
      const height = parseInt((bar as HTMLElement).style.height);
      expect(height).toBeGreaterThan(2);
    });
  });
});
