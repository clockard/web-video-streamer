/**
 * Watch a device's stream from the relay (GET /watch?device=<id> over
 * WebSocket): MPEG-TS is demuxed in the page, video is decoded with WebCodecs
 * and drawn to a canvas, audio is decoded and played through Web Audio, and
 * ST 0601 KLV metadata is decoded and emitted.
 *
 * Playback favours latency over smoothness: the newest decoded frame is drawn
 * on each animation frame and audio is played as it arrives with a short lead,
 * without A/V sync.
 */
import { decodeSt0601, type St0601Metadata } from './klv/st0601';
import { audioSpecificConfig, fromAdts, fromOpusTs, sampleRateFromIndex } from './ts/audio';
import { TsDemuxer, type DemuxedAudioCodec, type DemuxedSample } from './ts/demuxer';
import { splitNalUnits } from './ts/muxer';

export type PlayerState = 'connecting' | 'waiting' | 'playing' | 'stopped' | 'error';

export interface PlayerOptions {
  /** Watch URL, e.g. "wss://host/relay/watch?device=phone-1". */
  url: string;
  canvas: HTMLCanvasElement;
  /** Decode and play audio (default true). */
  audio?: boolean;
  /**
   * Context to play audio through. Create it in a user gesture (e.g. the
   * Watch button's click handler) so it is allowed to start; otherwise the
   * player creates one, which may stay suspended until a gesture.
   */
  audioContext?: AudioContext;
  /** Start muted (default false); see setMuted(). */
  muted?: boolean;
  /** Reconnect after the connection drops (default true). */
  reconnect?: boolean;
}

export interface PlayerStats {
  /** Frames drawn over the last second. */
  fps: number;
  /** Received bits per second over the last second. */
  bitrate: number;
  framesDecoded: number;
  /** Frames skipped while waiting for a keyframe or because decoding fell behind. */
  framesDropped: number;
  codec?: string;
  width?: number;
  height?: number;
  audioCodec?: DemuxedAudioCodec;
  audioFramesDecoded: number;
  bytesReceived: number;
}

interface PlayerEvents {
  state: PlayerState;
  metadata: St0601Metadata;
  stats: PlayerStats;
  error: Error;
  warning: string;
}

type Listener<T> = (value: T) => void;

/** Close codes from the relay that mean retrying will not help. */
const FATAL_CLOSE_CODES = new Set([1008, 4004]);
const RECONNECT_MS = 2000;
/** Decoded audio is scheduled this far ahead of the audio clock. */
const AUDIO_LEAD_S = 0.15;
/** If queued audio gets further ahead than this, the backlog is dropped. */
const AUDIO_MAX_AHEAD_S = 1;
/** Frames waiting to be decoded before the player skips to the next keyframe. */
const MAX_DECODE_QUEUE = 8;

const hex = (n: number) => n.toString(16).padStart(2, '0').toUpperCase();
const ptsToUs = (pts90k: number | undefined) => Math.round(((pts90k ?? 0) * 100) / 9);

/** WebCodecs codec string ("avc1.PPCCLL") from an H.264 SPS NAL unit (with its header byte). */
export function h264CodecFromSps(sps: Uint8Array): string {
  return `avc1.${hex(sps[1])}${hex(sps[2])}${hex(sps[3])}`;
}

/** True when this browser can decode video for StreamPlayer (WebCodecs VideoDecoder). */
export function isPlaybackSupported(): boolean {
  return typeof VideoDecoder !== 'undefined' && typeof WebSocket !== 'undefined';
}

export class StreamPlayer {
  state: PlayerState = 'stopped';
  readonly stats: PlayerStats = { fps: 0, bitrate: 0, framesDecoded: 0, framesDropped: 0, audioFramesDecoded: 0, bytesReceived: 0 };

  private readonly listeners = new Map<keyof PlayerEvents, Set<Listener<never>>>();
  private readonly ctx2d: CanvasRenderingContext2D;
  private ws?: WebSocket;
  private demuxer?: TsDemuxer;
  private stopped = true;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private statsTimer?: ReturnType<typeof setInterval>;

  private video?: VideoDecoder;
  private videoCodec?: string;
  private needKeyframe = true;
  private pendingFrame?: VideoFrame;
  private raf?: number;
  private windowFrames = 0;
  private windowBytes = 0;

  private audio?: AudioDecoder;
  private audioKey?: string;
  private audioContext?: AudioContext;
  private ownsAudioContext = false;
  private gain?: GainNode;
  private playhead = 0;
  private muted: boolean;
  private warnedNoAudio = false;

  constructor(private readonly options: PlayerOptions) {
    const ctx = options.canvas.getContext('2d');
    if (!ctx) throw new Error('canvas 2D context unavailable');
    this.ctx2d = ctx;
    this.muted = options.muted ?? false;
  }

  on<K extends keyof PlayerEvents>(event: K, listener: Listener<PlayerEvents[K]>): () => void {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event)!.add(listener as Listener<never>);
    return () => this.off(event, listener);
  }

  off<K extends keyof PlayerEvents>(event: K, listener: Listener<PlayerEvents[K]>): void {
    this.listeners.get(event)?.delete(listener as Listener<never>);
  }

  /** Connect and start playing. Throws if the browser cannot decode video. */
  start(): void {
    if (!this.stopped) return;
    if (!isPlaybackSupported()) {
      const err = new Error('This browser cannot decode video (WebCodecs VideoDecoder is unavailable)');
      this.setState('error');
      this.emit('error', err);
      throw err;
    }
    this.stopped = false;
    if (this.options.audio !== false) this.setupAudioOutput();
    this.statsTimer = setInterval(() => this.reportStats(), 1000);
    this.connect();
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    clearTimeout(this.reconnectTimer);
    clearInterval(this.statsTimer);
    this.disconnect();
    if (this.ownsAudioContext) void this.audioContext?.close().catch(() => {});
    this.gain?.disconnect();
    this.audioContext = this.gain = undefined;
    this.setState('stopped');
  }

  /** Mute or unmute audio; also resumes the audio context if the browser suspended it. */
  setMuted(muted: boolean): void {
    this.muted = muted;
    if (this.gain) this.gain.gain.value = muted ? 0 : 1;
    if (!muted) void this.audioContext?.resume().catch(() => {});
  }

  private connect() {
    this.setState('connecting');
    this.demuxer = new TsDemuxer({
      onSample: (s) => this.onSample(s),
      onProgram: (p) => {
        this.stats.audioCodec = p.audio?.codec;
        if (p.audio && this.options.audio !== false && typeof AudioDecoder === 'undefined' && !this.warnedNoAudio) {
          this.warnedNoAudio = true;
          this.emit('warning', 'This browser cannot decode audio (WebCodecs AudioDecoder is unavailable); playing video only');
        }
      },
    });
    this.needKeyframe = true;

    const ws = new WebSocket(this.options.url);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    ws.onmessage = (e: MessageEvent<ArrayBuffer | string>) => {
      if (typeof e.data === 'string') {
        try {
          const msg = JSON.parse(e.data) as { type?: string; connected?: boolean };
          if (msg.type === 'status') this.onDeviceStatus(!!msg.connected);
        } catch {
          // Ignore malformed control messages.
        }
        return;
      }
      const bytes = new Uint8Array(e.data);
      this.stats.bytesReceived += bytes.length;
      this.windowBytes += bytes.length;
      this.demuxer?.push(bytes);
    };
    ws.onclose = (e) => {
      if (this.ws !== ws) return;
      this.disconnect();
      if (this.stopped) return;
      if (FATAL_CLOSE_CODES.has(e.code)) {
        this.stopped = true;
        clearInterval(this.statsTimer);
        this.setState('error');
        this.emit('error', new Error(e.reason || `relay closed the connection (${e.code})`));
        return;
      }
      if (this.options.reconnect === false) {
        this.stop();
        return;
      }
      this.emit('warning', `Connection to relay lost${e.reason ? ` (${e.reason})` : ''}; reconnecting`);
      this.setState('connecting');
      this.reconnectTimer = setTimeout(() => this.connect(), RECONNECT_MS);
    };
  }

  private disconnect() {
    const ws = this.ws;
    this.ws = undefined;
    if (ws && ws.readyState <= WebSocket.OPEN) ws.close();
    this.demuxer = undefined;
    this.closeVideo();
    this.closeAudio();
  }

  private onDeviceStatus(connected: boolean) {
    if (!connected) {
      // The device's next connection starts a new stream: wait for its first keyframe.
      this.needKeyframe = true;
      this.setState('waiting');
    } else if (this.state === 'waiting') {
      this.setState('connecting');
    }
  }

  private onSample(s: DemuxedSample) {
    if (s.kind === 'video') this.onVideo(s);
    else if (s.kind === 'audio') this.onAudio(s);
    else {
      const metadata = decodeSt0601(s.data);
      if (metadata) this.emit('metadata', metadata);
    }
  }

  // ---- video ----

  private onVideo(s: DemuxedSample) {
    if (s.discontinuity) this.needKeyframe = true;
    if (this.needKeyframe && !s.keyframe) {
      this.stats.framesDropped++;
      return;
    }
    if (s.keyframe) {
      const sps = splitNalUnits(s.data).find((n) => (n[0] & 0x1f) === 7);
      const codec = sps && sps.length >= 4 ? h264CodecFromSps(sps) : this.videoCodec;
      if (!codec) {
        this.stats.framesDropped++;
        return;
      }
      if (!this.video || this.video.state === 'closed' || codec !== this.videoCodec) this.openVideo(codec);
      this.needKeyframe = false;
    }
    const decoder = this.video;
    if (!decoder || decoder.state !== 'configured') return;
    if (decoder.decodeQueueSize > MAX_DECODE_QUEUE) {
      // Decoding cannot keep up; skip ahead to the next keyframe rather than fall further behind.
      this.needKeyframe = true;
      this.stats.framesDropped++;
      return;
    }
    try {
      decoder.decode(new EncodedVideoChunk({ type: s.keyframe ? 'key' : 'delta', timestamp: ptsToUs(s.pts), data: s.data }));
    } catch (err) {
      this.videoError(err as Error);
    }
  }

  private openVideo(codec: string) {
    this.closeVideo();
    const decoder = new VideoDecoder({
      output: (frame) => this.onFrame(frame),
      error: (err) => {
        if (this.video === decoder) this.videoError(err);
      },
    });
    // No description: the chunks are Annex-B with in-band SPS/PPS.
    decoder.configure({ codec, optimizeForLatency: true });
    this.video = decoder;
    this.videoCodec = codec;
    this.stats.codec = codec;
  }

  private videoError(err: Error) {
    this.emit('warning', `Video decoder error: ${err.message}; waiting for the next keyframe`);
    this.closeVideo();
    this.needKeyframe = true;
  }

  private closeVideo() {
    if (this.video && this.video.state !== 'closed') this.video.close();
    this.video = undefined;
    this.pendingFrame?.close();
    this.pendingFrame = undefined;
    if (this.raf !== undefined) cancelAnimationFrame(this.raf);
    this.raf = undefined;
  }

  private onFrame(frame: VideoFrame) {
    this.stats.framesDecoded++;
    if (this.pendingFrame) {
      this.pendingFrame.close();
      this.stats.framesDropped++;
    }
    this.pendingFrame = frame;
    this.raf ??= requestAnimationFrame(() => this.draw());
  }

  private draw() {
    this.raf = undefined;
    const frame = this.pendingFrame;
    this.pendingFrame = undefined;
    if (!frame) return;
    const canvas = this.options.canvas;
    if (canvas.width !== frame.displayWidth || canvas.height !== frame.displayHeight) {
      canvas.width = frame.displayWidth;
      canvas.height = frame.displayHeight;
    }
    this.stats.width = frame.displayWidth;
    this.stats.height = frame.displayHeight;
    this.ctx2d.drawImage(frame, 0, 0);
    frame.close();
    this.windowFrames++;
    if (this.state !== 'playing' && !this.stopped) this.setState('playing');
  }

  // ---- audio ----

  private setupAudioOutput() {
    if (typeof AudioContext === 'undefined') return;
    this.ownsAudioContext = !this.options.audioContext;
    const ctx = this.options.audioContext ?? new AudioContext({ latencyHint: 'interactive' });
    this.audioContext = ctx;
    this.gain = ctx.createGain();
    this.gain.gain.value = this.muted ? 0 : 1;
    this.gain.connect(ctx.destination);
    void ctx.resume().catch(() => {});
  }

  private onAudio(s: DemuxedSample) {
    if (!this.audioContext || typeof AudioDecoder === 'undefined') return;
    const codec = this.demuxer?.currentProgram.audio?.codec;
    let chunks: { data: Uint8Array; timestamp: number }[];
    let config: AudioDecoderConfig;
    const start = ptsToUs(s.pts);
    if (codec === 'aac') {
      const frames = fromAdts(s.data);
      if (!frames.length) return;
      const c = frames[0].config;
      const sampleRate = sampleRateFromIndex(c.sampleRateIndex);
      if (!sampleRate) return;
      config = { codec: `mp4a.40.${c.objectType}`, sampleRate, numberOfChannels: c.channels, description: audioSpecificConfig(c) };
      chunks = frames.map((f, i) => ({ data: f.raw, timestamp: start + Math.round((i * 1024 * 1e6) / sampleRate) }));
    } else if (codec === 'opus') {
      const packets = fromOpusTs(s.data);
      if (!packets.length) return;
      // TOC byte stereo flag; Opus always decodes at 48 kHz.
      config = { codec: 'opus', sampleRate: 48000, numberOfChannels: packets[0][0] & 0x04 ? 2 : 1 };
      chunks = packets.map((data, i) => ({ data, timestamp: start + i * 20_000 }));
    } else {
      return;
    }

    const key = `${config.codec}/${config.sampleRate}/${config.numberOfChannels}`;
    if (!this.audio || this.audio.state === 'closed' || key !== this.audioKey) {
      if (!this.openAudio(config, key)) return;
    }
    const decoder = this.audio!;
    if (decoder.decodeQueueSize > 50) return;
    try {
      for (const c of chunks) decoder.decode(new EncodedAudioChunk({ type: 'key', timestamp: c.timestamp, data: c.data }));
    } catch (err) {
      this.audioError(err as Error);
    }
  }

  private openAudio(config: AudioDecoderConfig, key: string): boolean {
    this.closeAudio();
    const decoder = new AudioDecoder({
      output: (data) => this.onAudioData(data),
      error: (err) => {
        if (this.audio === decoder) this.audioError(err);
      },
    });
    try {
      decoder.configure(config);
    } catch (err) {
      this.audioError(err as Error);
      return false;
    }
    this.audio = decoder;
    this.audioKey = key;
    return true;
  }

  private audioError(err: Error) {
    this.emit('warning', `Audio decoder error: ${err.message}`);
    this.closeAudio();
  }

  private closeAudio() {
    if (this.audio && this.audio.state !== 'closed') this.audio.close();
    this.audio = undefined;
    this.audioKey = undefined;
  }

  private onAudioData(data: AudioData) {
    const ctx = this.audioContext;
    const gain = this.gain;
    if (!ctx || !gain || data.numberOfFrames === 0) {
      data.close();
      return;
    }
    this.stats.audioFramesDecoded++;
    const buffer = ctx.createBuffer(data.numberOfChannels, data.numberOfFrames, data.sampleRate);
    for (let ch = 0; ch < data.numberOfChannels; ch++) {
      const plane = new Float32Array(data.numberOfFrames);
      data.copyTo(plane, { planeIndex: ch, format: 'f32-planar' });
      buffer.copyToChannel(plane, ch);
    }
    data.close();

    const now = ctx.currentTime;
    if (this.playhead < now + 0.02 || this.playhead > now + AUDIO_MAX_AHEAD_S) this.playhead = now + AUDIO_LEAD_S;
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(gain);
    source.start(this.playhead);
    this.playhead += buffer.duration;
  }

  // ---- events ----

  private reportStats() {
    this.stats.fps = this.windowFrames;
    this.stats.bitrate = this.windowBytes * 8;
    this.windowFrames = this.windowBytes = 0;
    this.emit('stats', { ...this.stats });
  }

  private setState(state: PlayerState) {
    if (state === this.state) return;
    this.state = state;
    this.emit('state', state);
  }

  private emit<K extends keyof PlayerEvents>(event: K, value: PlayerEvents[K]) {
    this.listeners.get(event)?.forEach((fn) => (fn as Listener<PlayerEvents[K]>)(value));
  }
}

/** Create a player for a relay watch URL; call start() to begin. */
export function createPlayer(options: PlayerOptions): StreamPlayer {
  return new StreamPlayer(options);
}
