import { describe, expect, it } from "vitest";
import {
  createPcm16DownsamplerState,
  downsampleInputChunkToPcm16Frames,
  measurePcm16AudioFrame,
} from "./audio-capture-math.ts";

describe("audio capture math", () => {
  it("produces near-zero PCM metrics for silence", () => {
    const frame = new Int16Array(320);
    expect(measurePcm16AudioFrame(frame, 16000)).toEqual({
      sampleCount: 320,
      byteLength: 640,
      rms: 0,
      peak: 0,
      nonZeroRatio: 0,
      clippedRatio: 0,
      durationMs: 20,
    });
  });

  it("downsamples a voiced waveform into the expected frame size", () => {
    const state = createPcm16DownsamplerState({
      sourceSampleRate: 48000,
      targetSampleRate: 16000,
      frameDurationMs: 20,
    });
    const chunk = new Float32Array(960);
    for (let index = 0; index < chunk.length; index += 1) {
      chunk[index] = Math.sin((index / 24) * Math.PI) * 0.5;
    }

    const frames = downsampleInputChunkToPcm16Frames(chunk, state);

    expect(frames).toHaveLength(1);
    expect(frames[0]).toHaveLength(320);
    const metrics = measurePcm16AudioFrame(frames[0], 16000);
    expect(metrics.rms).toBeGreaterThan(0.2);
    expect(metrics.peak).toBeGreaterThan(0.45);
    expect(metrics.nonZeroRatio).toBeGreaterThan(0.95);
  });

  it("preserves frame sizing across multiple chunks", () => {
    const state = createPcm16DownsamplerState({
      sourceSampleRate: 48000,
      targetSampleRate: 16000,
      frameDurationMs: 20,
    });
    const chunk = new Float32Array(480);
    chunk.fill(0.25);

    const firstPass = downsampleInputChunkToPcm16Frames(chunk, state);
    const secondPass = downsampleInputChunkToPcm16Frames(chunk, state);

    expect(firstPass).toHaveLength(0);
    expect(secondPass).toHaveLength(1);
    expect(secondPass[0]).toHaveLength(320);
  });

  it("reports clipped and non-zero sample ratios for known PCM", () => {
    const frame = Int16Array.from([0, 16384, -16384, 32767, -32768]);
    const metrics = measurePcm16AudioFrame(frame, 16000);

    expect(metrics.sampleCount).toBe(5);
    expect(metrics.byteLength).toBe(10);
    expect(metrics.nonZeroRatio).toBe(0.8);
    expect(metrics.clippedRatio).toBe(0.4);
    expect(metrics.peak).toBe(1);
    expect(metrics.rms).toBeGreaterThan(0.6);
  });
});
