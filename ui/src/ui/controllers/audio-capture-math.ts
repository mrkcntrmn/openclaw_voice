export type Pcm16AudioMetrics = {
  sampleCount: number;
  byteLength: number;
  rms: number;
  peak: number;
  nonZeroRatio: number;
  clippedRatio: number;
  durationMs: number;
};

export type Pcm16DownsamplerState = {
  sourceToTargetRatio: number;
  frameSamples: number;
  pendingPosition: number;
  pendingAccumulator: number;
  pendingCount: number;
  frame: number[];
};

export function createPcm16DownsamplerState(params: {
  sourceSampleRate: number;
  targetSampleRate: number;
  frameDurationMs: number;
}): Pcm16DownsamplerState {
  return {
    sourceToTargetRatio: params.sourceSampleRate / params.targetSampleRate,
    frameSamples: Math.max(1, Math.round((params.targetSampleRate * params.frameDurationMs) / 1000)),
    pendingPosition: 0,
    pendingAccumulator: 0,
    pendingCount: 0,
    frame: [],
  };
}

export function downsampleInputChunkToPcm16Frames(
  input: ArrayLike<number>,
  state: Pcm16DownsamplerState,
): Int16Array[] {
  const frames: Int16Array[] = [];

  for (let index = 0; index < input.length; index += 1) {
    const sample = input[index] ?? 0;
    state.pendingAccumulator += sample;
    state.pendingCount += 1;
    state.pendingPosition += 1;
    if (state.pendingPosition < state.sourceToTargetRatio) {
      continue;
    }

    const averagedSample =
      state.pendingCount > 0 ? state.pendingAccumulator / state.pendingCount : 0;
    state.pendingAccumulator = 0;
    state.pendingCount = 0;
    state.pendingPosition -= state.sourceToTargetRatio;

    const clamped = Math.max(-1, Math.min(1, averagedSample));
    const pcmSample = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
    state.frame.push(Math.max(-32768, Math.min(32767, Math.round(pcmSample))));

    if (state.frame.length < state.frameSamples) {
      continue;
    }

    frames.push(Int16Array.from(state.frame));
    state.frame = [];
  }

  return frames;
}

export function measurePcm16AudioFrame(
  frame: ArrayBuffer | ArrayLike<number>,
  sampleRateHz: number,
): Pcm16AudioMetrics {
  const samples =
    frame instanceof ArrayBuffer
      ? new Int16Array(frame, 0, Math.floor(frame.byteLength / 2))
      : frame;
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
    const rawSample = Number(samples[index] ?? 0);
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
