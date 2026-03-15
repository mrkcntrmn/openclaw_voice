import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AudioPlayback } from "./audio-playback.ts";

const createdContexts: FakeAudioContext[] = [];

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
  sampleRate = 48_000;
  destination = {};
  readonly sources: FakeAudioBufferSourceNode[] = [];
  constructor(options?: { sampleRate?: number }) {
    if (options?.sampleRate) {
      this.sampleRate = options.sampleRate;
    }
    createdContexts.push(this);
  }
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
    const source = new FakeAudioBufferSourceNode();
    this.sources.push(source);
    return source;
  }
}

describe("AudioPlayback", () => {
  beforeEach(() => {
    createdContexts.length = 0;
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

  it("drops buffered backlog and resumes near real time when playback falls behind", () => {
    const debug = vi.fn();
    const playback = new AudioPlayback(16000, {
      backlogCapSec: 0.35,
      onDebug: debug,
    });
    playback.start();

    const buffer = new Int16Array(320).buffer;
    for (let index = 0; index < 20; index += 1) {
      playback.enqueue(buffer);
    }

    const context = createdContexts[0];
    const startTimes = context?.sources
      .map((source) => source.start.mock.calls[0]?.[0])
      .filter((value): value is number => typeof value === "number");
    const resetIndex =
      startTimes?.findIndex((value, index, values) => index > 0 && value < values[index - 1]) ?? -1;

    expect(resetIndex).toBeGreaterThan(0);
    expect(
      context?.sources
        .slice(0, resetIndex)
        .some((source) => source.stop.mock.calls.length > 0),
    ).toBe(true);
    expect(startTimes?.[resetIndex]).toBeCloseTo(0.03, 3);
    expect(playback.getBufferedAheadSec()).toBeLessThanOrEqual(0.35);
    expect(debug).toHaveBeenCalledWith(
      "voice playback backlog reset",
      expect.objectContaining({
        transportSampleRateHz: 16000,
        contextSampleRateHz: context.sampleRate,
        backlogCapSec: 0.35,
      }),
    );
  });
});
