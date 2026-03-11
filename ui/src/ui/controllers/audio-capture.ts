const CAPTURE_WORKLET_NAME = "openclaw-pcm16-capture";
const loadedWorkletContexts = new WeakSet<AudioContext>();

const CAPTURE_WORKLET_SOURCE = `
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
    this.frameSamples = Math.max(1, Math.round((this.targetSampleRate * this.frameDurationMs) / 1000));
    this.sourceToTargetRatio = sampleRate / this.targetSampleRate;
    this.pendingPosition = 0;
    this.pendingAccumulator = 0;
    this.pendingCount = 0;
    this.frame = [];
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

    for (let index = 0; index < input.length; index += 1) {
      const sample = input[index];
      this.volumeAccumulator += sample * sample;
      this.volumeCount += 1;

      this.pendingAccumulator += sample;
      this.pendingCount += 1;
      this.pendingPosition += 1;
      if (this.pendingPosition < this.sourceToTargetRatio) {
        continue;
      }

      const averagedSample = this.pendingCount > 0 ? this.pendingAccumulator / this.pendingCount : 0;
      this.pendingAccumulator = 0;
      this.pendingCount = 0;
      this.pendingPosition -= this.sourceToTargetRatio;
      const clamped = Math.max(-1, Math.min(1, averagedSample));
      const pcmSample = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
      this.frame.push(Math.max(-32768, Math.min(32767, Math.round(pcmSample))));

      if (this.frame.length < this.frameSamples) {
        continue;
      }

      const payload = new Int16Array(this.frame);
      this.frame = [];
      this.port.postMessage(payload.buffer, [payload.buffer]);
    }

    this.volumeUpdateCounter += 1;
    if (this.volumeUpdateCounter >= 4) { // ~60fps assuming 128 samples per block at 48kHz
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

export type AudioCaptureOptions = {
  sampleRateHz: number;
  frameDurationMs: number;
  onAudioData: (data: ArrayBuffer) => void;
  onVolumeChange?: (volume: number) => void;
};

export class AudioCapture {
  private context: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private worklet: AudioWorkletNode | null = null;
  private sink: GainNode | null = null;

  constructor(private options: AudioCaptureOptions) {}

  async start(): Promise<void> {
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

    this.worklet.port.onmessage = (event: MessageEvent<ArrayBuffer | { type: "volume"; value: number }>) => {
      if (typeof event.data === "object" && event.data !== null && "type" in event.data && event.data.type === "volume") {
        this.options.onVolumeChange?.(event.data.value);
        return;
      }
      this.options.onAudioData(event.data as ArrayBuffer);
    };

    this.sink = this.context.createGain();
    this.sink.gain.value = 0;

    this.source.connect(this.worklet);
    this.worklet.connect(this.sink);
    this.sink.connect(this.context.destination);
  }

  async stop(): Promise<void> {
    if (this.worklet) {
      this.worklet.port.onmessage = null;
      try {
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
