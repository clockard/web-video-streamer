/**
 * Camera frames -> H.264 Annex-B access units using WebCodecs.
 *
 * Frames come from MediaStreamTrackProcessor where available (Chromium), and
 * otherwise are grabbed from a <video> element with requestVideoFrameCallback
 * (Safari, Firefox). All frames are re-stamped on one clock (microseconds
 * since the encoder started) so the muxer can align video and KLV.
 */

export interface EncoderOptions {
  bitrate?: number;
  fps?: number;
  keyframeIntervalMs?: number;
  /**
   * Skip frames while more than this many milliseconds of video (at the
   * configured bitrate) are waiting to be sent, so latency stays bounded on a
   * slow uplink instead of growing. Default 500.
   */
  maxQueueMs?: number;
}

export interface EncodedFrame {
  data: Uint8Array;
  timestampUs: number;
  keyframe: boolean;
}

/**
 * H.264 profiles in order of preference: High and Main compress roughly 10-15%
 * better than Constrained Baseline at the same quality.
 */
const PROFILES = [
  { name: 'High', id: '6400' },
  { name: 'Main', id: '4D40' },
  { name: 'Constrained Baseline', id: '42E0' },
];

/** Level 3.1 covers up to 1280x720 at 30 fps; larger frames need level 4.0 (hex 1F / 28). */
function codecString(profileId: string, width: number, height: number): string {
  return `avc1.${profileId}${width * height > 1280 * 720 ? '28' : '1F'}`;
}

/** Never let the send queue limit drop below a typical keyframe. */
const MIN_QUEUE_BYTES = 64_000;

export function isEncodingSupported(): boolean {
  return typeof VideoEncoder !== 'undefined' && typeof VideoFrame !== 'undefined';
}

export class FrameEncoder {
  dropped = 0;
  encoded = 0;
  /** H.264 profile in use, e.g. "High". */
  profile?: string;
  /** Called whenever the encoded frame size is (re)configured. */
  onFrameSize?: (width: number, height: number) => void;

  private encoder?: VideoEncoder;
  private config?: VideoEncoderConfig;
  private lastKeyframeUs = -Infinity;
  private forceKeyframe = true;
  private running = false;
  private busy = false;
  private needsReconfigure = false;
  private baselineOnly = false;
  private lastOutputUs = -Infinity;
  private lastFrameUs = -Infinity;
  private stopSource?: () => void;
  private readonly startMs = performance.now();

  constructor(
    private readonly track: MediaStreamTrack,
    private readonly options: EncoderOptions,
    private readonly onFrame: (frame: EncodedFrame) => void,
    private readonly onError: (err: Error) => void,
    /** Bytes waiting to be sent; used for backpressure. */
    private readonly queuedBytes: () => number = () => 0,
  ) {}

  /** Microseconds since the encoder was created: the shared stream clock. */
  nowUs(): number {
    return Math.round((performance.now() - this.startMs) * 1000);
  }

  async start(video?: HTMLVideoElement): Promise<void> {
    if (!isEncodingSupported()) throw new Error('WebCodecs VideoEncoder is not supported in this browser');
    this.running = true;
    this.stopSource = hasTrackProcessor() ? this.readTrack() : this.readVideoElement(video);
  }

  requestKeyframe(): void {
    this.forceKeyframe = true;
  }

  /** Target bitrate in bits/s; undefined selects one based on resolution. Applies from the next frame. */
  setBitrate(bitrate: number | undefined): void {
    this.options.bitrate = bitrate;
    this.needsReconfigure = true;
  }

  /** Maximum encoded frame rate. Frames arriving faster than this are skipped. */
  setFrameRate(fps: number): void {
    this.options.fps = fps;
    this.needsReconfigure = true;
  }

  /** Bitrate the encoder is currently configured with. */
  get bitrate(): number | undefined {
    return this.config?.bitrate;
  }

  /** Codec string in use, e.g. "avc1.64001F". */
  get codec(): string | undefined {
    return this.config?.codec;
  }

  get fps(): number {
    return this.options.fps ?? 30;
  }

  async stop(): Promise<void> {
    this.running = false;
    this.stopSource?.();
    if (this.encoder && this.encoder.state !== 'closed') {
      try {
        await this.encoder.flush();
      } catch {
        // Flushing a failed encoder rejects; nothing left to emit.
      }
      this.encoder.close();
    }
  }

  private async handleFrame(source: VideoFrame | HTMLVideoElement) {
    // Skip frames that arrive while a previous one is still (re)configuring the encoder.
    if (this.busy) {
      this.dropped++;
      return;
    }
    const timestamp = this.nowUs();
    // Enforce the target frame rate when the camera delivers frames faster
    // (allowing 10% jitter so a 30 fps camera is not halved at 30 fps).
    if (timestamp - this.lastFrameUs < 900_000 / this.fps) return;
    this.lastFrameUs = timestamp;
    this.busy = true;
    let frame: VideoFrame | undefined;
    try {
      frame = new VideoFrame(source, { timestamp });
      await this.ensureEncoder(frame.displayWidth, frame.displayHeight);
      const encoder = this.encoder!;
      const maxQueued = Math.max(MIN_QUEUE_BYTES, ((this.config?.bitrate ?? 0) / 8) * ((this.options.maxQueueMs ?? 500) / 1000));
      if (encoder.encodeQueueSize > 2 || this.queuedBytes() > maxQueued) {
        this.dropped++;
        return;
      }
      const interval = (this.options.keyframeIntervalMs ?? 1000) * 1000;
      const keyFrame = this.forceKeyframe || timestamp - this.lastKeyframeUs >= interval;
      if (keyFrame) {
        this.forceKeyframe = false;
        this.lastKeyframeUs = timestamp;
      }
      encoder.encode(frame, { keyFrame });
    } catch (err) {
      this.onError(err as Error);
    } finally {
      frame?.close();
      this.busy = false;
    }
  }

  /** (Re)configure when the frame size changes, e.g. when the phone rotates. */
  private async ensureEncoder(width: number, height: number) {
    // H.264 needs even dimensions; the encoder scales if they differ from the frame.
    width -= width % 2;
    height -= height % 2;
    if (this.config && this.config.width === width && this.config.height === height && !this.needsReconfigure) return;
    this.needsReconfigure = false;

    const base = {
      width,
      height,
      bitrate: this.options.bitrate ?? defaultBitrate(width, height),
      framerate: this.fps,
      latencyMode: 'realtime' as const,
      avc: { format: 'annexb' as const },
    };
    let config: VideoEncoderConfig | undefined;
    const profiles = this.baselineOnly ? PROFILES.slice(-1) : PROFILES;
    for (const profile of profiles) {
      const candidate = { ...base, codec: codecString(profile.id, width, height) };
      const { supported } = await VideoEncoder.isConfigSupported(candidate).catch(() => ({ supported: false }));
      if (supported) {
        config = candidate;
        this.profile = profile.name;
        break;
      }
    }
    if (!config) throw new Error(`No supported H.264 encoder configuration for ${width}x${height}`);

    if (!this.encoder || this.encoder.state === 'closed') {
      this.encoder = new VideoEncoder({
        output: (chunk) => {
          // The muxer writes PTS only, which assumes no B-frames. Realtime mode
          // should not produce them; if an encoder reorders frames anyway, fall
          // back to Constrained Baseline, which cannot.
          if (chunk.timestamp < this.lastOutputUs && !this.baselineOnly) {
            this.baselineOnly = true;
            this.needsReconfigure = true;
          }
          this.lastOutputUs = chunk.timestamp;
          const data = new Uint8Array(chunk.byteLength);
          chunk.copyTo(data);
          this.encoded++;
          this.onFrame({ data, timestampUs: chunk.timestamp, keyframe: chunk.type === 'key' });
        },
        error: (e) => this.onError(e instanceof Error ? e : new Error(String(e))),
      });
    }
    this.encoder.configure(config);
    this.config = config;
    this.forceKeyframe = true;
    this.onFrameSize?.(width, height);
  }

  private readTrack(): () => void {
    const Processor = (globalThis as unknown as { MediaStreamTrackProcessor: new (o: { track: MediaStreamTrack }) => { readable: ReadableStream<VideoFrame> } })
      .MediaStreamTrackProcessor;
    const reader = new Processor({ track: this.track }).readable.getReader();
    (async () => {
      while (this.running) {
        const { value, done } = await reader.read();
        if (done) break;
        await this.handleFrame(value);
        value.close();
      }
    })().catch((err) => this.running && this.onError(err));
    return () => void reader.cancel().catch(() => {});
  }

  private readVideoElement(video?: HTMLVideoElement): () => void {
    const el = video ?? document.createElement('video');
    if (!video) {
      el.muted = true;
      el.playsInline = true;
      el.srcObject = new MediaStream([this.track]);
      void el.play();
    }
    let handle = 0;
    const tick = () => {
      if (!this.running) return;
      // handleFrame drops frames beyond the target rate (rAF may fire at 60+ Hz).
      if (el.readyState >= 2) void this.handleFrame(el);
      handle = 'requestVideoFrameCallback' in el ? el.requestVideoFrameCallback(tick) : requestAnimationFrame(tick);
    };
    tick();
    return () => {
      if ('cancelVideoFrameCallback' in el) el.cancelVideoFrameCallback(handle);
      else cancelAnimationFrame(handle);
      if (!video) el.srcObject = null;
    };
  }
}

function hasTrackProcessor(): boolean {
  return typeof (globalThis as { MediaStreamTrackProcessor?: unknown }).MediaStreamTrackProcessor === 'function';
}

/** Roughly 0.1 bits per pixel at 30 fps, clamped to sensible mobile-uplink bounds. */
function defaultBitrate(width: number, height: number): number {
  return Math.min(6_000_000, Math.max(500_000, Math.round(width * height * 30 * 0.1)));
}
