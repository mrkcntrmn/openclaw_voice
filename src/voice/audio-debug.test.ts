import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildMonoPcm16WavBuffer,
  isVoiceAudioDumpEnabled,
  measurePcm16AudioBuffer,
  roundVoiceAudioMetric,
} from "./audio-debug.js";

describe("voice audio debug helpers", () => {
  const envSnapshot = new Map<string, string | undefined>();

  beforeEach(() => {
    for (const key of ["OPENCLAW_DEBUG_VOICE", "OPENCLAW_DEBUG_VOICE_AUDIO_DUMP"]) {
      envSnapshot.set(key, process.env[key]);
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const [key, value] of envSnapshot) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    envSnapshot.clear();
  });

  it("measures PCM16 metrics from known samples", () => {
    const pcm = Int16Array.from([0, 8192, -8192, 32767, -32768]);
    const metrics = measurePcm16AudioBuffer(pcm, 16000);

    expect(metrics.sampleCount).toBe(5);
    expect(metrics.byteLength).toBe(10);
    expect(metrics.nonZeroRatio).toBe(0.8);
    expect(metrics.clippedRatio).toBe(0.4);
    expect(roundVoiceAudioMetric(metrics.peak)).toBe(1);
    expect(metrics.rms).toBeGreaterThan(0.5);
  });

  it("builds a mono PCM16 wav header", () => {
    const pcm = Buffer.from(Int16Array.from([0, 32767]).buffer);
    const wav = buildMonoPcm16WavBuffer(pcm, 16000);

    expect(wav.subarray(0, 4).toString("ascii")).toBe("RIFF");
    expect(wav.subarray(8, 12).toString("ascii")).toBe("WAVE");
    expect(wav.subarray(36, 40).toString("ascii")).toBe("data");
    expect(wav.readUInt16LE(22)).toBe(1);
    expect(wav.readUInt32LE(24)).toBe(16000);
    expect(wav.readUInt16LE(34)).toBe(16);
  });

  it("requires the master voice debug flag before enabling audio dumps", () => {
    expect(isVoiceAudioDumpEnabled()).toBe(false);

    process.env.OPENCLAW_DEBUG_VOICE_AUDIO_DUMP = "1";
    expect(isVoiceAudioDumpEnabled()).toBe(false);

    process.env.OPENCLAW_DEBUG_VOICE = "1";
    expect(isVoiceAudioDumpEnabled()).toBe(true);
  });
});
