const READY_LATENCY_PADDING_SEC = 0.03;

export class AudioPlayback {
  private context: AudioContext | null = null;
  private gain: GainNode | null = null;
  private sources = new Set<AudioBufferSourceNode>();
  private nextStartTime = 0;

  constructor(private sampleRateHz: number) {}

  start(): void {
    this.context = new AudioContext();
    this.gain = this.context.createGain();
    this.gain.gain.value = 1;
    this.gain.connect(this.context.destination);
    this.nextStartTime = this.context.currentTime + READY_LATENCY_PADDING_SEC;
  }

  stop(): void {
    for (const source of this.sources) {
      try {
        source.stop();
      } catch {
        // Ignore
      }
      try {
        source.disconnect();
      } catch {
        // Ignore
      }
    }
    this.sources.clear();
    if (this.gain) {
      try {
        this.gain.disconnect();
      } catch {
        // Ignore
      }
    }
    if (this.context && this.context.state !== "closed") {
      void this.context.close().catch(() => {});
    }
    this.context = null;
    this.gain = null;
  }

  enqueue(payload: ArrayBuffer): void {
    if (!this.context || !this.gain || payload.byteLength < 2) {
      return;
    }
    const sampleCount = Math.floor(payload.byteLength / 2);
    if (sampleCount < 1) {
      return;
    }
    const pcm = new Int16Array(payload, 0, sampleCount);
    const normalized = new Float32Array(pcm.length);
    for (let index = 0; index < pcm.length; index += 1) {
      normalized[index] = pcm[index] / 0x8000;
    }

    const audioBuffer = this.context.createBuffer(1, normalized.length, this.sampleRateHz);
    audioBuffer.copyToChannel(normalized, 0);

    const source = this.context.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(this.gain);
    source.addEventListener("ended", () => {
      this.sources.delete(source);
      try {
        source.disconnect();
      } catch {
        // Ignore
      }
    });

    const startTime = Math.max(
      this.context.currentTime + READY_LATENCY_PADDING_SEC,
      this.nextStartTime,
    );
    source.start(startTime);
    this.nextStartTime = startTime + audioBuffer.duration;
    this.sources.add(source);
  }

  interrupt(): void {
    for (const source of this.sources) {
      try {
        source.stop();
      } catch {
        // Ignore
      }
      try {
        source.disconnect();
      } catch {
        // Ignore
      }
    }
    this.sources.clear();
    if (this.context) {
      this.nextStartTime = this.context.currentTime + READY_LATENCY_PADDING_SEC;
    }
  }
}
