import {
  downsampleInputChunkToPcm16Frames,
  measurePcm16AudioFrame,
  type Pcm16AudioMetrics,
} from "./audio-capture-math.ts";

const CAPTURE_WORKLET_NAME = "openclaw-pcm16-capture";
const loadedWorkletContexts = new WeakSet<AudioContext>();

const CAPTURE_WORKLET_SOURCE = `
${downsampleInputChunkToPcm16Frames.toString()}
${measurePcm16AudioFrame.toString()}
class OpenClawPcm16CaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const processorOptions = options?.processorOptions ?? {};
    this.targetSampleRate =
      typeof processorOptions.targetSampleRate === "number"
        ? processorOptions.targetSampleRate
        : 16000;
    this.frameDurationMs =
      typeof processorOptions.frameDurationMs === "number"
        ? processorOptions.frameDurationMs
        : 20;
    this.captureState = {
      sourceToTargetRatio: sampleRate / this.targetSampleRate,
      frameSamples: Math.max(1, Math.round((this.targetSampleRate * this.frameDurationMs) / 1000)),
      pendingPosition: 0,
      pendingAccumulator: 0,
      pendingCount: 0,
      frame: [],
    };
    this.volumeUpdateCounter = 0;
    this.volumeAccumulator = 0;
    this.volumeCount = 0;
  }

  process(inputs, outputs) {
    const output = outputs?.[0];
    if (output) {
      for (const channel of output) {
        channel.fill(0);
      }
    }

    const input = inputs?.[0]?.[0];
    if (!input || input.length === 0) {
      return true;
    }

    const frames = downsampleInputChunkToPcm16Frames(input, this.captureState);
    for (const payload of frames) {
      const metrics = measurePcm16AudioFrame(payload, this.targetSampleRate);
      this.port.postMessage(
        { type: "audio", payload: payload.buffer, metrics },
        [payload.buffer],
      );
    }

    for (let index = 0; index < input.length; index += 1) {
      const sample = input[index];
      this.volumeAccumulator += sample * sample;
      this.volumeCount += 1;
    }

    this.volumeUpdateCounter += 1;
    if (this.volumeUpdateCounter >= 4) {
      this.volumeUpdateCounter = 0;
      const rms = Math.sqrt(this.volumeCount > 0 ? this.volumeAccumulator / this.volumeCount : 0);
      this.port.postMessage({ type: "volume", value: rms });
      this.volumeAccumulator = 0;
      this.volumeCount = 0;
    }

    return true;
  }
}

registerProcessor("${CAPTURE_WORKLET_NAME}", OpenClawPcm16CaptureProcessor);
`;

type AudioCaptureWorkletVolumeMessage = {
  type: "volume";
  value: number;
};

type AudioCaptureWorkletAudioMessage = {
  type: "audio";
  payload: ArrayBuffer;
  metrics?: Pcm16AudioMetrics;
};

export type AudioCaptureOptions = {
  sampleRateHz: number;
  frameDurationMs: number;
  onAudioData: (data: ArrayBuffer) => void;
  onVolumeChange?: (volume: number) => void;
  onAudioFrameStats?: (stats: Pcm16AudioMetrics & { sequence: number }) => void;
};

export class AudioCapture {
  private context: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private worklet: AudioWorkletNode | null = null;
  private sink: GainNode | null = null;
  private frameSequence = 0;

  constructor(private options: AudioCaptureOptions) {}

  async start(): Promise<void> {
    this.frameSequence = 0;
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });

    this.context = new AudioContext();
    await this.context.resume();
    await this.ensureWorklet(this.context);

    this.source = this.context.createMediaStreamSource(this.stream);
    this.worklet = new AudioWorkletNode(this.context, CAPTURE_WORKLET_NAME, {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      processorOptions: {
        targetSampleRate: this.options.sampleRateHz,
        frameDurationMs: this.options.frameDurationMs,
      },
    });

    this.worklet.port.addEventListener(
      "message",
      (event: MessageEvent<AudioCaptureWorkletAudioMessage | AudioCaptureWorkletVolumeMessage | ArrayBuffer>) => {
        const data = event.data;
        if (typeof data === "object" && data !== null && "type" in data && data.type === "volume") {
          this.options.onVolumeChange?.(data.value);
          return;
        }

        if (typeof data === "object" && data !== null && "type" in data && data.type === "audio") {
          const sequence = ++this.frameSequence;
          const metrics = data.metrics ?? measurePcm16AudioFrame(data.payload, this.options.sampleRateHz);
          this.options.onAudioFrameStats?.({ sequence, ...metrics });
          this.options.onAudioData(data.payload);
          return;
        }

        if (data instanceof ArrayBuffer) {
          const sequence = ++this.frameSequence;
          const metrics = measurePcm16AudioFrame(data, this.options.sampleRateHz);
          this.options.onAudioFrameStats?.({ sequence, ...metrics });
          this.options.onAudioData(data);
        }
      },
    );
    this.worklet.port.start();

    this.sink = this.context.createGain();
    this.sink.gain.value = 0;

    this.source.connect(this.worklet);
    this.worklet.connect(this.sink);
    this.sink.connect(this.context.destination);
  }

  async stop(): Promise<void> {
    if (this.worklet) {
      try {
        this.worklet.port.close();
        this.worklet.disconnect();
      } catch {
        // Ignore
      }
    }
    if (this.source) {
      try {
        this.source.disconnect();
      } catch {
        // Ignore
      }
    }
    if (this.sink) {
      try {
        this.sink.disconnect();
      } catch {
        // Ignore
      }
    }
    if (this.stream) {
      for (const track of this.stream.getTracks()) {
        track.stop();
      }
    }
    if (this.context && this.context.state !== "closed") {
      await this.context.close().catch(() => {});
    }
    this.context = null;
    this.stream = null;
    this.source = null;
    this.worklet = null;
    this.sink = null;
    this.frameSequence = 0;
  }

  private async ensureWorklet(context: AudioContext): Promise<void> {
    if (loadedWorkletContexts.has(context)) {
      return;
    }
    const blob = new Blob([CAPTURE_WORKLET_SOURCE], { type: "application/javascript" });
    const moduleUrl = URL.createObjectURL(blob);
    try {
      await context.audioWorklet.addModule(moduleUrl);
      loadedWorkletContexts.add(context);
    } finally {
      URL.revokeObjectURL(moduleUrl);
    }
  }
}
