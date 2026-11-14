/**
 * Microphone audio -> AAC (ADTS) or Opus frames using WebCodecs.
 *
 * AAC-LC is preferred, as standard MPEG-TS / STANAG 4609 receivers expect it;
 * browsers that cannot encode AAC (Firefox, Chromium on Linux) use Opus.
 * Samples come from MediaStreamTrackProcessor where available (Chromium) and
 * otherwise from an AudioWorklet (Safari, Firefox). Every block is re-stamped
 * on the shared stream clock by sample count, so audio stays continuous and
 * lines up with video and KLV.
 */
import type { StreamClock } from './clock';
import { parseAudioSpecificConfig, sampleRateIndex, toAdts, toOpusTs, type AacConfig } from './ts/audio';
import type { AudioCodec, MuxerAudioConfig } from './ts/muxer';

export interface AudioOptions {
  /** Audio bitrate in bits/s. Default 64 kbps for AAC, 48 kbps for Opus. */
  bitrate?: number;
  /** 1 (mono, default) or 2 (stereo). */
  channels?: number;
  /** Requested capture sample rate. Default: the microphone's own (usually 48 kHz). */
  sampleRate?: number;
  /** A specific microphone's MediaDeviceInfo.deviceId. */
  microphoneId?: string;
  /** Extra capture constraints, e.g. { echoCancellation: false, noiseSuppression: false }. */
  constraints?: MediaTrackConstraints;
}

export interface EncodedAudio {
  /** One frame, framed for MPEG-TS: ADTS AAC, or an Opus packet with its control header. */
  data: Uint8Array;
  /** The same frame unframed: raw AAC (no ADTS header) or a bare Opus packet. */
  raw: Uint8Array;
  timestampUs: number;
  durationUs: number;
}

export function isAudioEncodingSupported(): boolean {
  return typeof AudioEncoder !== 'undefined' && typeof AudioData !== 'undefined';
}

/** getUserMedia audio constraints for the options. */
export function audioConstraints(options: AudioOptions = {}): MediaTrackConstraints {
  return {
    ...(options.microphoneId ? { deviceId: { exact: options.microphoneId } } : {}),
    channelCount: { ideal: options.channels ?? 1 },
    ...(options.sampleRate ? { sampleRate: { ideal: options.sampleRate } } : {}),
    ...options.constraints,
  };
}

const CODECS: { codec: AudioCodec; id: string; bitrate: number }[] = [
  { codec: 'aac', id: 'mp4a.40.2', bitrate: 64_000 },
  { codec: 'opus', id: 'opus', bitrate: 48_000 },
];

/** Sample rates AAC can signal in ADTS and that encoders commonly accept. */
const AAC_RATES = [48000, 44100, 32000, 24000, 22050, 16000];

/** Re-anchor timestamps to the clock if sample counting drifts this far from it (e.g. after a stall). */
const MAX_DRIFT_US = 100_000;

/**
 * Timestamps successive sample blocks by sample count, anchored to the stream
 * clock. Counting samples avoids the jitter of arrival times; large
 * disagreement with the clock (dropped audio, a suspended context) re-anchors.
 */
export class AudioTimestamper {
  private nextUs?: number;

  constructor(private readonly nowUs: () => number) {}

  /** Presentation time of a block of `frames` samples at `sampleRate` that has just arrived. */
  stamp(frames: number, sampleRate: number): number {
    const durationUs = (frames * 1_000_000) / sampleRate;
    // The block's first sample was captured about one block duration ago.
    const arrivalStart = Math.max(0, this.nowUs() - durationUs);
    if (this.nextUs === undefined || Math.abs(this.nextUs - arrivalStart) > MAX_DRIFT_US) this.nextUs = arrivalStart;
    const ts = this.nextUs;
    this.nextUs += durationUs;
    return Math.round(ts);
  }
}

/**
 * Groups encoded audio frames into PES packets of about `intervalUs` each.
 * One ~20 ms frame per PES would waste about half the bytes on TS packet
 * headers and stuffing. A PES carries only its first frame's PTS, so a
 * timestamp discontinuity also starts a new one.
 */
export class AudioPesBuffer {
  private frames: EncodedAudio[] = [];
  private durationUs = 0;

  constructor(
    private readonly onPes: (frames: Uint8Array[], timestampUs: number) => void,
    private readonly intervalUs = 100_000,
  ) {}

  push(frame: EncodedAudio): void {
    const last = this.frames.at(-1);
    if (last && Math.abs(last.timestampUs + last.durationUs - frame.timestampUs) > last.durationUs / 2) this.flush();
    this.frames.push(frame);
    this.durationUs += frame.durationUs;
    if (this.durationUs >= this.intervalUs) this.flush();
  }

  flush(): void {
    if (!this.frames.length) return;
    const frames = this.frames;
    this.frames = [];
    this.durationUs = 0;
    this.onPes(
      frames.map((f) => f.data),
      frames[0].timestampUs,
    );
  }
}

/** Mix planar channels down (or up) to `channels`. */
export function remixPlanes(planes: Float32Array[], channels: number): Float32Array[] {
  if (planes.length === channels) return planes;
  if (channels === 1) {
    const out = new Float32Array(planes[0].length);
    for (const p of planes) for (let i = 0; i < out.length; i++) out[i] += p[i] / planes.length;
    return [out];
  }
  // More channels requested than captured: repeat the last ones.
  return Array.from({ length: channels }, (_, c) => planes[Math.min(c, planes.length - 1)]);
}

/** A block of captured samples, planar float32. */
interface SampleBlock {
  planes: Float32Array[];
  sampleRate: number;
}

export class AudioEncoderPipeline {
  encoded = 0;
  /** Codec chosen by prepare(). */
  codec?: AudioCodec;

  private encoder?: AudioEncoder;
  private config?: AudioEncoderConfig;
  private aac?: AacConfig;
  private running = false;
  private stopSource?: () => void;
  private readonly timestamper: AudioTimestamper;
  private readonly channels: number;

  constructor(
    private readonly track: MediaStreamTrack,
    private readonly options: AudioOptions,
    clock: StreamClock,
    private readonly onFrame: (frame: EncodedAudio) => void,
    private readonly onError: (err: Error) => void,
  ) {
    this.timestamper = new AudioTimestamper(() => clock.nowUs());
    this.channels = Math.min(Math.max(options.channels ?? 1, 1), 2);
  }

  /** What the muxer must announce in its PMT. Valid after prepare(). */
  get muxConfig(): MuxerAudioConfig | undefined {
    return this.codec ? { codec: this.codec, channels: this.channels } : undefined;
  }

  /** Encoder bitrate in bits/s, once configured. */
  get bitrate(): number | undefined {
    return this.config?.bitrate;
  }

  /** WebCodecs codec string ("mp4a.40.2" or "opus"). Valid after prepare(). */
  get codecString(): 'mp4a.40.2' | 'opus' | undefined {
    return this.codec && (this.codec === 'aac' ? 'mp4a.40.2' : 'opus');
  }

  /** Sample rate in use, or the one expected before the first samples arrive. */
  get sampleRate(): number {
    const rate = this.config?.sampleRate ?? this.track.getSettings().sampleRate ?? this.options.sampleRate ?? 48000;
    return this.codec === 'aac' && !this.config ? nearestAacRate(rate) : rate;
  }

  get channelCount(): number {
    return this.channels;
  }

  /** Pick the codec: AAC if this browser can encode it, else Opus. Throws if neither works. */
  async prepare(): Promise<void> {
    if (!isAudioEncodingSupported()) throw new Error('This browser does not support WebCodecs audio encoding');
    const sampleRate = this.track.getSettings().sampleRate ?? this.options.sampleRate ?? 48000;
    for (const c of CODECS) {
      const rate = c.codec === 'aac' ? nearestAacRate(sampleRate) : sampleRate;
      const config = { codec: c.id, sampleRate: rate, numberOfChannels: this.channels, bitrate: this.options.bitrate ?? c.bitrate };
      const { supported } = await AudioEncoder.isConfigSupported(config).catch(() => ({ supported: false }));
      if (supported) {
        this.codec = c.codec;
        return;
      }
    }
    throw new Error('This browser cannot encode AAC or Opus audio');
  }

  /** Start capturing and encoding. Call after prepare(). */
  start(): void {
    if (!this.codec) throw new Error('AudioEncoderPipeline.prepare() must succeed before start()');
    this.running = true;
    const onBlock = (block: SampleBlock) => {
      if (!this.running) return;
      try {
        this.encode(block);
      } catch (err) {
        this.fail(err as Error);
      }
    };
    const source = hasTrackProcessor() ? readTrack(this.track, onBlock) : readWorklet(this.track, onBlock);
    this.stopSource = source.stop;
    source.done.catch((err) => this.fail(err));
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

  private fail(err: Error) {
    if (!this.running) return;
    this.running = false;
    this.onError(err);
  }

  private encode(block: SampleBlock) {
    const frames = block.planes[0]?.length ?? 0;
    if (!frames) return;
    const planes = remixPlanes(block.planes, this.channels);
    this.ensureEncoder(block.sampleRate);
    const data = new Float32Array(frames * this.channels);
    planes.forEach((p, c) => data.set(p, c * frames));
    const audio = new AudioData({
      format: 'f32-planar',
      sampleRate: block.sampleRate,
      numberOfFrames: frames,
      numberOfChannels: this.channels,
      timestamp: this.timestamper.stamp(frames, block.sampleRate),
      data,
    });
    try {
      this.encoder!.encode(audio);
    } finally {
      audio.close();
    }
  }

  /** (Re)configure for the capture's actual sample rate, which is only known once samples arrive. */
  private ensureEncoder(sampleRate: number) {
    if (this.config?.sampleRate === sampleRate) return;
    const c = CODECS.find((x) => x.codec === this.codec)!;
    if (c.codec === 'aac' && sampleRateIndex(sampleRate) < 0) throw new Error(`AAC cannot carry ${sampleRate} Hz audio`);
    const config: AudioEncoderConfig = {
      codec: c.id,
      sampleRate,
      numberOfChannels: this.channels,
      bitrate: this.options.bitrate ?? c.bitrate,
    };
    if (!this.encoder || this.encoder.state === 'closed') {
      this.encoder = new AudioEncoder({
        output: (chunk, metadata) => this.output(chunk, metadata),
        error: (e) => this.fail(e instanceof Error ? e : new Error(String(e))),
      });
    }
    this.encoder.configure(config);
    this.config = config;
    this.aac = c.codec === 'aac' ? { objectType: 2, sampleRateIndex: sampleRateIndex(sampleRate), channels: this.channels } : undefined;
  }

  private output(chunk: EncodedAudioChunk, metadata?: EncodedAudioChunkMetadata) {
    const raw = new Uint8Array(chunk.byteLength);
    chunk.copyTo(raw);
    const description = metadata?.decoderConfig?.description;
    if (this.codec === 'aac' && description) {
      const asc = ArrayBuffer.isView(description)
        ? new Uint8Array(description.buffer, description.byteOffset, description.byteLength)
        : new Uint8Array(description);
      this.aac = parseAudioSpecificConfig(asc) ?? this.aac;
    }
    let data: Uint8Array;
    let unframed = raw;
    if (this.codec === 'opus') {
      data = toOpusTs(raw);
    } else if (raw[0] === 0xff && (raw[1] & 0xf6) === 0xf0) {
      // Some encoders already emit ADTS: 7-byte header, or 9 with a CRC (protection_absent = 0).
      data = raw;
      unframed = raw.subarray(raw[1] & 0x01 ? 7 : 9);
    } else {
      data = toAdts(this.aac!, raw);
    }
    const sampleRate = this.config?.sampleRate ?? 48000;
    const durationUs = chunk.duration ?? (this.codec === 'aac' ? (1024 * 1_000_000) / sampleRate : 20_000);
    this.encoded++;
    this.onFrame({ data, raw: unframed, timestampUs: chunk.timestamp, durationUs });
  }
}

function nearestAacRate(rate: number): number {
  return AAC_RATES.reduce((best, r) => (Math.abs(r - rate) < Math.abs(best - rate) ? r : best));
}

function hasTrackProcessor(): boolean {
  return typeof (globalThis as { MediaStreamTrackProcessor?: unknown }).MediaStreamTrackProcessor === 'function';
}

interface Source {
  stop: () => void;
  /** Rejects if capture fails. */
  done: Promise<void>;
}

/** Chromium: AudioData straight from the track. */
function readTrack(track: MediaStreamTrack, onBlock: (b: SampleBlock) => void): Source {
  const Processor = (globalThis as unknown as { MediaStreamTrackProcessor: new (o: { track: MediaStreamTrack }) => { readable: ReadableStream<AudioData> } })
    .MediaStreamTrackProcessor;
  const reader = new Processor({ track }).readable.getReader();
  let running = true;
  const done = (async () => {
    while (running) {
      const { value, done } = await reader.read();
      if (done) break;
      try {
        const planes = Array.from({ length: value.numberOfChannels }, (_, c) => {
          const p = new Float32Array(value.numberOfFrames);
          value.copyTo(p, { planeIndex: c, format: 'f32-planar' });
          return p;
        });
        onBlock({ planes, sampleRate: value.sampleRate });
      } finally {
        value.close();
      }
    }
  })();
  return {
    stop: () => {
      running = false;
      void reader.cancel().catch(() => {});
    },
    done: done.catch((err) => {
      if (running) throw err;
    }),
  };
}

/** Collects ~1024-sample blocks (128-sample render quanta) and posts them to the page. */
const WORKLET = `
class Capture extends AudioWorkletProcessor {
  constructor() { super(); this.blocks = []; this.frames = 0; }
  process(inputs) {
    const input = inputs[0];
    if (input && input.length) {
      this.blocks.push(input.map((ch) => ch.slice()));
      this.frames += input[0].length;
      if (this.frames >= 1024) {
        const planes = input.map((_, c) => {
          const out = new Float32Array(this.frames);
          let o = 0;
          for (const b of this.blocks) { out.set(b[c] || b[0], o); o += b[0].length; }
          return out;
        });
        this.port.postMessage(planes, planes.map((p) => p.buffer));
        this.blocks = []; this.frames = 0;
      }
    }
    return true;
  }
}
registerProcessor('wvs-audio-capture', Capture);
`;

/** Safari, Firefox: an AudioWorklet taps the track through Web Audio. */
function readWorklet(track: MediaStreamTrack, onBlock: (b: SampleBlock) => void): Source {
  // Use the device rate: Firefox cannot connect a track to a context at a different rate.
  const ctx = new AudioContext();
  let stopped = false;
  const url = URL.createObjectURL(new Blob([WORKLET], { type: 'text/javascript' }));
  const done = (async () => {
    try {
      await ctx.audioWorklet.addModule(url);
    } finally {
      URL.revokeObjectURL(url);
    }
    if (stopped) return;
    const source = ctx.createMediaStreamSource(new MediaStream([track]));
    const node = new AudioWorkletNode(ctx, 'wvs-audio-capture', { numberOfInputs: 1, numberOfOutputs: 1 });
    node.port.onmessage = (e: MessageEvent<Float32Array[]>) => onBlock({ planes: e.data, sampleRate: ctx.sampleRate });
    // Some browsers only render nodes that reach the destination; a silent gain keeps it quiet.
    const mute = ctx.createGain();
    mute.gain.value = 0;
    source.connect(node).connect(mute).connect(ctx.destination);
    await ctx.resume();
  })();
  return {
    stop: () => {
      stopped = true;
      void ctx.close().catch(() => {});
    },
    done: done.catch((err) => {
      if (!stopped) throw err;
    }),
  };
}
