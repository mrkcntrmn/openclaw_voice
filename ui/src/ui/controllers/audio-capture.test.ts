import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { AudioCapture } from "./audio-capture.ts";

class FakeTrack {
  stopped = false;
  stop(): void {
    this.stopped = true;
  }
}

class FakeMediaStream {
  private readonly tracks = [new FakeTrack()];
  getTracks(): FakeTrack[] {
    return this.tracks;
  }
}

class FakeAudioNode {
  connect = vi.fn(() => this);
  disconnect = vi.fn();
}

class FakeAudioContext {
  state: "running" | "closed" = "running";
  audioWorklet = {
    addModule: vi.fn(async () => undefined),
  };
  async resume(): Promise<void> {
    return;
  }
  async close(): Promise<void> {
    this.state = "closed";
  }
  createMediaStreamSource(): FakeAudioNode {
    return new FakeAudioNode();
  }
  createGain(): { gain: { value: number } } & FakeAudioNode {
    return { gain: { value: 1 }, ...new FakeAudioNode() };
  }
  destination = {};
}

class FakeAudioWorkletNode extends FakeAudioNode {
  port = {
    onmessage: null as ((event: { data: ArrayBuffer }) => void) | null,
  };
  constructor(_context: unknown, _name: string, _options?: unknown) {
    super();
  }
}

describe("AudioCapture", () => {
  beforeEach(() => {
    vi.stubGlobal("AudioContext", FakeAudioContext);
    vi.stubGlobal("AudioWorkletNode", FakeAudioWorkletNode);
    vi.stubGlobal("navigator", {
      mediaDevices: {
        getUserMedia: vi.fn(async () => new FakeMediaStream()),
      },
    });
    vi.stubGlobal("URL", {
      createObjectURL: vi.fn(() => "blob:test"),
      revokeObjectURL: vi.fn(),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("starts and stops capture", async () => {
    const onAudioData = vi.fn();
    const capture = new AudioCapture({
      sampleRateHz: 16000,
      frameDurationMs: 20,
      onAudioData,
    });

    await capture.start();
    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalled();

    await capture.stop();
  });
});
