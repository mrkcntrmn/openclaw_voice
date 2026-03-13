import { isTruthyEnvValue } from "../infra/env.js";

export type VoicePcm16AudioMetrics = {
  sampleCount: number;
  byteLength: number;
  rms: number;
  peak: number;
  nonZeroRatio: number;
  clippedRatio: number;
  durationMs: number;
};

function resolvePcm16View(value: ArrayBuffer | Buffer | Int16Array): Int16Array {
  if (value instanceof Int16Array) {
    return value;
  }
  if (Buffer.isBuffer(value)) {
    return new Int16Array(value.buffer, value.byteOffset, Math.floor(value.byteLength / 2));
  }
  return new Int16Array(value, 0, Math.floor(value.byteLength / 2));
}

export function measurePcm16AudioBuffer(
  value: ArrayBuffer | Buffer | Int16Array,
  sampleRateHz: number,
): VoicePcm16AudioMetrics {
  const samples = resolvePcm16View(value);
  const sampleCount = samples.length;
  if (sampleCount === 0 || !Number.isFinite(sampleRateHz) || sampleRateHz <= 0) {
    return {
      sampleCount,
      byteLength: sampleCount * 2,
      rms: 0,
      peak: 0,
      nonZeroRatio: 0,
      clippedRatio: 0,
      durationMs: 0,
    };
  }

  let sumSquares = 0;
  let peak = 0;
  let nonZeroCount = 0;
  let clippedCount = 0;

  for (let index = 0; index < sampleCount; index += 1) {
    const rawSample = samples[index] ?? 0;
    const normalized = rawSample / 0x8000;
    const absolute = Math.abs(normalized);
    sumSquares += normalized * normalized;
    if (absolute > 0) {
      nonZeroCount += 1;
    }
    if (absolute > peak) {
      peak = absolute;
    }
    if (Math.abs(rawSample) >= 32760) {
      clippedCount += 1;
    }
  }

  return {
    sampleCount,
    byteLength: sampleCount * 2,
    rms: Math.sqrt(sumSquares / sampleCount),
    peak,
    nonZeroRatio: nonZeroCount / sampleCount,
    clippedRatio: clippedCount / sampleCount,
    durationMs: (sampleCount / sampleRateHz) * 1000,
  };
}

export function roundVoiceAudioMetric(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

export function buildMonoPcm16WavBuffer(pcm: Buffer, sampleRateHz: number): Buffer {
  const channels = 1;
  const bitDepth = 16;
  const blockAlign = (channels * bitDepth) / 8;
  const byteRate = sampleRateHz * blockAlign;
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRateHz, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitDepth, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

export function isVoiceAudioDumpEnabled(): boolean {
  return (
    isTruthyEnvValue(process.env.OPENCLAW_DEBUG_VOICE) &&
    isTruthyEnvValue(process.env.OPENCLAW_DEBUG_VOICE_AUDIO_DUMP)
  );
}
