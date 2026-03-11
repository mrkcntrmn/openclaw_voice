import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { AudioPlayback } from "./audio-playback.ts";

class FakeAudioNode {
  connect = vi.fn(() => this);
  disconnect = vi.fn();
}

class FakeGainNode extends FakeAudioNode {
  gain = { value: 1 };
}

class FakeAudioBufferSourceNode extends FakeAudioNode {
  buffer: unknown = null;
  addEventListener = vi.fn();
  start = vi.fn();
  stop = vi.fn();
}

class FakeAudioContext {
  state: "running" | "closed" = "running";
  currentTime = 0;
  destination = {};
  async close(): Promise<void> {
    this.state = "closed";
  }
  createGain(): FakeGainNode {
    return new FakeGainNode();
  }
  createBuffer(_channels: number, length: number, sampleRate: number) {
    return {
      duration: length / sampleRate,
      copyToChannel: vi.fn(),
    };
  }
  createBufferSource(): FakeAudioBufferSourceNode {
    return new FakeAudioBufferSourceNode();
  }
}

describe("AudioPlayback", () => {
  beforeEach(() => {
    vi.stubGlobal("AudioContext", FakeAudioContext);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("starts and stops playback", () => {
    const playback = new AudioPlayback(16000);
    playback.start();
    playback.stop();
  });

  it("enqueues and interrupts playback", () => {
    const playback = new AudioPlayback(16000);
    playback.start();
    
    const buffer = new Int16Array(320).buffer; // 20ms at 16kHz
    playback.enqueue(buffer);
    
    playback.interrupt();
    playback.stop();
  });
});
