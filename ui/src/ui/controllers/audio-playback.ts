const PLAYBACK_TARGET_LEAD_SEC = 0.09;
const PLAYBACK_MIN_START_LEAD_SEC = 0.02;
const DEFAULT_PLAYBACK_BACKLOG_CAP_SEC = 0.35;

type AudioPlaybackOptions = {
  backlogCapSec?: number;
  onDebug?: (message: string, meta: Record<string, unknown>) => void;
};

export class AudioPlayback {
  private context: AudioContext | null = null;
  private gain: GainNode | null = null;
  private sources = new Set<AudioBufferSourceNode>();
  private nextStartTime = 0;
  private firstBufferScheduled = false;

  constructor(
    private sampleRateHz: number,
    private options: AudioPlaybackOptions = {},
  ) {}

  getBufferedAheadSec(): number {
    if (!this.context) {
      return 0;
    }
    return Math.max(0, this.nextStartTime - this.context.currentTime);
  }

  start(): void {
    this.context = new AudioContext();
    this.gain = this.context.createGain();
    this.gain.gain.value = 1;
    this.gain.connect(this.context.destination);
    this.resetScheduleLead();
    this.firstBufferScheduled = false;
    this.options.onDebug?.("voice playback context", {
      transportSampleRateHz: this.sampleRateHz,
      contextSampleRateHz: this.context.sampleRate,
      targetLeadSec: PLAYBACK_TARGET_LEAD_SEC,
      minStartLeadSec: PLAYBACK_MIN_START_LEAD_SEC,
      backlogCapSec: this.options.backlogCapSec ?? DEFAULT_PLAYBACK_BACKLOG_CAP_SEC,
    });
  }

  stop(): void {
    this.clearSources();
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
    this.nextStartTime = 0;
    this.firstBufferScheduled = false;
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

    const bufferedAheadSec = this.getBufferedAheadSec();
    const backlogCapSec = this.options.backlogCapSec ?? DEFAULT_PLAYBACK_BACKLOG_CAP_SEC;
    if (bufferedAheadSec > backlogCapSec) {
      // Drop stale queued audio so playback stays close to the live conversation.
      this.options.onDebug?.("voice playback backlog reset", {
        transportSampleRateHz: this.sampleRateHz,
        contextSampleRateHz: this.context.sampleRate,
        bufferedAheadSec,
        backlogCapSec,
        byteLength: payload.byteLength,
      });
      this.clearSources();
      this.resetScheduleLead();
    }

    const minStartTime = this.context.currentTime + PLAYBACK_MIN_START_LEAD_SEC;
    const startTime = Math.max(minStartTime, this.nextStartTime);
    if (this.firstBufferScheduled && this.nextStartTime < minStartTime) {
      this.options.onDebug?.("voice playback underrun", {
        transportSampleRateHz: this.sampleRateHz,
        contextSampleRateHz: this.context.sampleRate,
        bufferedAheadSec,
        byteLength: payload.byteLength,
        recoveredLeadSec: Math.max(0, startTime - this.context.currentTime),
      });
    }
    if (!this.firstBufferScheduled) {
      this.firstBufferScheduled = true;
      this.options.onDebug?.("voice playback buffer scheduled", {
        transportSampleRateHz: this.sampleRateHz,
        contextSampleRateHz: this.context.sampleRate,
        byteLength: payload.byteLength,
        startDelaySec: Math.max(0, startTime - this.context.currentTime),
        durationSec: audioBuffer.duration,
      });
    }
    source.start(startTime);
    this.nextStartTime = startTime + audioBuffer.duration;
    this.sources.add(source);
  }

  interrupt(): void {
    this.clearSources();
    if (this.context) {
      this.resetScheduleLead();
    }
  }

  private resetScheduleLead(): void {
    if (!this.context) {
      this.nextStartTime = 0;
      return;
    }
    // Keep a modest lead so websocket jitter does not turn into audible gaps.
    this.nextStartTime = this.context.currentTime + PLAYBACK_TARGET_LEAD_SEC;
  }

  private clearSources(): void {
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
  }
}
