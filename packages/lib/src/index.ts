/**
 * web-video-streamer — stream a browser camera as MPEG-TS with MISB ST 0601
 * KLV metadata. Browsers cannot send UDP, so the transport stream is sent
 * over WebTransport or a WebSocket to a relay (see web-video-streamer-relay)
 * that forwards it to the UDP target.
 */
import { cameraLabel, openCamera, trackZoom, type CameraOptions } from './camera';
import { FrameEncoder, isEncodingSupported } from './encoder';
import {
  fovFromPhotoInfo,
  readPhotoInfo,
  takePhotoWithImageCapture,
  type FovResult,
  type FovSource,
  type PhotoInfo,
} from './fov';
import { encodeSt0601, type St0601Metadata } from './klv/st0601';
import { computeFootprint, type Footprint, type FootprintOptions } from './footprint';
import { requestOrientationPermission, SensorTracker, type CameraPose, type Position } from './sensors';
import { relayUrl, WebSocketTransport, type Transport, type TransportEvents } from './transport';
import { isWebTransportSupported, WebTransportTransport, type WebTransportMode } from './webtransport';
import { TsMuxer } from './ts/muxer';

export interface StreamerOptions extends CameraOptions {
  /**
   * WebSocket URL of the relay, e.g. "wss://relay.example.com:8090". Relative URLs resolve against the page.
   * Required unless transport is 'webtransport'.
   */
  relayUrl?: string;
  /**
   * 'auto' (default) uses WebTransport when the browser supports it and webTransportUrl is set,
   * falling back to WebSocket if it cannot connect. 'webtransport' or 'websocket' force one.
   */
  transport?: 'auto' | 'webtransport' | 'websocket';
  /** WebTransport URL of the relay, e.g. "https://relay.example.com:4433/stream". */
  webTransportUrl?: string;
  /** 'datagram' (default): unreliable, lowest latency. 'stream': reliable and ordered. */
  webTransportMode?: WebTransportMode;
  /** Base64 SHA-256 of the relay's self-signed WebTransport certificate (served by the relay at /cert-hash). */
  serverCertificateHash?: string;
  /** UDP destination the relay should send to, e.g. "udp://10.0.0.5:5000". Optional if the relay has a default. */
  target?: string;
  /** Video bitrate in bits per second (default scales with resolution). */
  bitrate?: number;
  keyframeIntervalMs?: number;
  /** Skip frames while more than this much video (ms at the current bitrate) is waiting to be sent. Default 500. */
  maxQueueMs?: number;
  /** How often KLV metadata is inserted (default 1000 ms). */
  klvIntervalMs?: number;
  /** Fixed FOV in degrees for the video frame; skips photo-based estimation. */
  fovOverride?: { horizontal: number; vertical: number };
  /**
   * A photo from the device's native camera app (see capturePhotoWithNativeCamera),
   * used for FOV estimation in preference to an in-page ImageCapture photo.
   */
  calibrationPhoto?: Blob;
  /** Magnetic declination in degrees (east positive) added to compass headings. */
  declination?: number;
  /**
   * Ground footprint settings (camera height above ground, range cap), or
   * false to leave the frame centre, slant range and corner tags out of the KLV.
   */
  footprint?: FootprintOptions | false;
  missionId?: string;
  platformDesignation?: string;
  /** Element to show the camera preview in; also used as the frame source where needed. */
  videoElement?: HTMLVideoElement;
}

export type StreamerState = 'idle' | 'initializing' | 'streaming' | 'reconnecting' | 'stopped' | 'error';

export interface StreamStats {
  fps: number;
  bitrate: number;
  /** Configured frame rate limit. */
  targetFps: number;
  /** Bitrate the encoder is configured with (bits/s). */
  targetBitrate?: number;
  /** Transport in use, e.g. "webtransport/datagram" or "websocket". */
  transport?: string;
  /** Codec string and H.264 profile in use, e.g. "avc1.64001F" / "High". */
  codec?: string;
  profile?: string;
  framesEncoded: number;
  framesDropped: number;
  bytesSent: number;
}

export interface MetadataSnapshot {
  timestamp: Date;
  position?: Position;
  pose?: CameraPose;
  fov: FovResult;
  /** Ground area in view; present when position and an absolute heading are known. */
  footprint?: Footprint;
}

interface StreamerEvents {
  state: StreamerState;
  fov: FovResult;
  metadata: MetadataSnapshot;
  stats: StreamStats;
  error: Error;
  warning: string;
}

type Listener<T> = (value: T) => void;

export class Streamer {
  state: StreamerState = 'idle';
  stream?: MediaStream;
  fov?: FovResult;

  private readonly listeners = new Map<keyof StreamerEvents, Set<Listener<never>>>();
  private sensors?: SensorTracker;
  private encoder?: FrameEncoder;
  private transport?: Transport;
  private muxer?: TsMuxer;
  private timers: ReturnType<typeof setInterval>[] = [];
  private photoInfo?: PhotoInfo;
  private fovSource: FovSource = 'default';
  private frameSize = { width: 0, height: 0 };
  private videoStarted = false;

  private readonly options: StreamerOptions;

  constructor(options: StreamerOptions) {
    // Copied so setBitrate/setFrameRate don't modify the caller's object.
    this.options = { ...options };
  }

  on<K extends keyof StreamerEvents>(event: K, listener: Listener<StreamerEvents[K]>): () => void {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event)!.add(listener as Listener<never>);
    return () => this.off(event, listener);
  }

  off<K extends keyof StreamerEvents>(event: K, listener: Listener<StreamerEvents[K]>): void {
    this.listeners.get(event)?.delete(listener as Listener<never>);
  }

  /**
   * Start streaming. Call from a user gesture (e.g. a button click) so iOS
   * can show the motion-sensor permission prompt.
   */
  async start(): Promise<void> {
    if (this.state === 'initializing' || this.state === 'streaming') return;
    // Must run before the first await to keep the user-gesture activation on iOS.
    const orientationPermission = requestOrientationPermission();
    this.setState('initializing');
    this.videoStarted = false;

    try {
      if (!isEncodingSupported()) throw new Error('This browser does not support WebCodecs video encoding');

      this.stream = await openCamera(this.options);
      const track = this.stream.getVideoTracks()[0];
      if (this.options.videoElement) {
        this.options.videoElement.srcObject = this.stream;
        this.options.videoElement.muted = true;
        this.options.videoElement.playsInline = true;
        await this.options.videoElement.play().catch(() => {});
      }

      if (!(await orientationPermission)) {
        this.emit('warning', 'Motion sensor permission was not granted; pointing direction may be unavailable');
      }
      this.sensors = new SensorTracker({ declination: this.options.declination });
      this.sensors.start((err) => this.emit('warning', err.message));

      await this.initFov(track);

      this.muxer = new TsMuxer({ onData: (d) => this.transport?.send(d) });
      this.transport = await this.connectTransport();

      this.encoder = new FrameEncoder(
        track,
        {
          bitrate: this.options.bitrate,
          fps: this.options.fps,
          keyframeIntervalMs: this.options.keyframeIntervalMs,
          maxQueueMs: this.options.maxQueueMs,
        },
        (frame) => {
          this.videoStarted = true;
          this.muxer?.writeVideo(frame.data, frame.timestampUs, frame.keyframe);
        },
        (err) => this.fail(err),
        () => this.transport?.bufferedAmount ?? 0,
      );
      this.encoder.onFrameSize = (width, height) => {
        this.frameSize = { width, height };
        this.updateFov(track);
      };
      await this.encoder.start(this.options.videoElement);

      this.timers.push(setInterval(() => this.sendMetadata(), this.options.klvIntervalMs ?? 1000));
      this.timers.push(setInterval(this.statsTimer(), 1000));
      this.setState('streaming');
    } catch (err) {
      this.fail(err as Error);
      throw err;
    }
  }

  async stop(): Promise<void> {
    this.timers.splice(0).forEach(clearInterval);
    await this.encoder?.stop();
    this.transport?.close();
    this.sensors?.stop();
    this.stream?.getTracks().forEach((t) => t.stop());
    if (this.options.videoElement) this.options.videoElement.srcObject = null;
    this.encoder = this.transport = this.sensors = this.muxer = undefined;
    this.stream = undefined;
    if (this.state !== 'error') this.setState('stopped');
  }

  /** Transport in use while streaming, e.g. "webtransport/datagram" or "websocket". */
  get transportKind(): string | undefined {
    return this.transport?.kind;
  }

  /** Connect to the relay with the configured transport, falling back from WebTransport to WebSocket in 'auto'. */
  private async connectTransport(): Promise<Transport> {
    const events: TransportEvents = {
      onOpen: () => {
        // Receivers joining mid-stream need a fresh keyframe (and PAT/PMT, sent with it).
        this.encoder?.requestKeyframe();
        if (this.state === 'reconnecting') this.setState('streaming');
      },
      onClose: (reason) => {
        if (this.state !== 'streaming' && this.state !== 'reconnecting') return;
        if (reason.endsWith('reconnecting')) {
          this.setState('reconnecting');
        } else {
          this.fail(new Error(`Relay closed the connection: ${reason}`));
        }
      },
    };
    const { transport: choice = 'auto', webTransportUrl, relayUrl: wsUrl, target } = this.options;

    if (choice === 'webtransport' || (choice === 'auto' && webTransportUrl)) {
      if (!isWebTransportSupported()) {
        if (choice === 'webtransport') throw new Error('This browser does not support WebTransport');
        this.emit('warning', 'This browser does not support WebTransport; using WebSocket');
      } else if (!webTransportUrl) {
        throw new Error('webTransportUrl is required for WebTransport');
      } else {
        const wt = new WebTransportTransport(
          webTransportUrl,
          { mode: this.options.webTransportMode ?? 'datagram', target, serverCertificateHash: this.options.serverCertificateHash },
          events,
        );
        try {
          await wt.connect();
          return wt;
        } catch (err) {
          if (choice === 'webtransport' || !wsUrl) throw err;
          this.emit('warning', `WebTransport failed (${(err as Error).message}); falling back to WebSocket`);
        }
      }
    }

    if (!wsUrl) throw new Error('relayUrl is required for WebSocket');
    const ws = new WebSocketTransport(relayUrl(wsUrl, target), events);
    await ws.connect();
    return ws;
  }

  /**
   * Change the video bitrate (bits/s); undefined picks one from the resolution.
   * Takes effect immediately while streaming (with a new keyframe), or at the next start.
   */
  setBitrate(bitrate: number | undefined): void {
    this.options.bitrate = bitrate;
    this.encoder?.setBitrate(bitrate);
  }

  /** Change the maximum frame rate. Takes effect immediately while streaming, or at the next start. */
  setFrameRate(fps: number): void {
    if (!(fps > 0)) throw new RangeError(`invalid frame rate ${fps}`);
    this.options.fps = fps;
    this.encoder?.setFrameRate(fps);
    // Also ask the camera for the new rate, so it can capture faster or save power.
    void this.stream
      ?.getVideoTracks()[0]
      ?.applyConstraints({ frameRate: { ideal: fps } })
      .catch(() => {});
  }

  /** Change the ground footprint settings. Takes effect from the next KLV packet. */
  setFootprintOptions(options: FootprintOptions): void {
    this.options.footprint = { ...this.options.footprint, ...options };
  }

  /** Latest sensor readings, FOV and ground footprint, as they will appear in the next KLV packet. */
  snapshot(): MetadataSnapshot | undefined {
    if (!this.fov) return undefined;
    const position = this.sensors?.position;
    const pose = this.sensors?.pose();
    // Only absolute (north-referenced) headings can be placed on the ground.
    const footprint =
      position && pose?.absolute && this.options.footprint !== false
        ? computeFootprint(position, pose, this.fov, this.options.footprint)
        : undefined;
    return { timestamp: new Date(), position, pose, fov: this.fov, footprint };
  }

  private async initFov(track: MediaStreamTrack) {
    const settings = track.getSettings();
    this.frameSize = { width: settings.width ?? 1280, height: settings.height ?? 720 };

    let source: FovSource = 'default';
    if (this.options.calibrationPhoto) {
      this.photoInfo = await readPhotoInfo(this.options.calibrationPhoto).catch(() => ({}));
      source = 'photo-exif';
    }
    if (!this.photoInfo?.focalLength35mm) {
      const photo = await takePhotoWithImageCapture(track);
      const info = photo ? await readPhotoInfo(photo).catch(() => ({}) as PhotoInfo) : {};
      if (info.focalLength35mm) {
        this.photoInfo = info;
        source = 'image-capture-exif';
      }
    }
    this.photoInfo ??= {};
    this.fovSource = this.photoInfo.focalLength35mm ? source : 'default';
    this.updateFov(track);
    if (this.fov?.source === 'default') {
      this.emit('warning', 'No lens EXIF data found; using a default field of view. Calibrate with a native camera photo for accuracy.');
    }
  }

  private updateFov(track: MediaStreamTrack) {
    const { width, height } = this.frameSize;
    const override = this.options.fovOverride;
    if (override) {
      // The override describes the frame as configured; swap axes if the frame orientation differs.
      const swap = (height > width) !== (override.vertical > override.horizontal);
      this.fov = {
        horizontal: swap ? override.vertical : override.horizontal,
        vertical: swap ? override.horizontal : override.vertical,
        source: 'override',
      };
    } else {
      this.fov = fovFromPhotoInfo(this.photoInfo ?? {}, width, height, this.fovSource, trackZoom(track));
    }
    this.emit('fov', this.fov);
  }

  private sendMetadata() {
    const snap = this.snapshot();
    if (!snap || !this.muxer || !this.encoder || !this.videoStarted) return;
    const { position, pose, fov } = snap;
    const nowUs = BigInt(Math.round((performance.timeOrigin + performance.now()) * 1000));
    const track = this.stream?.getVideoTracks()[0];
    const sensorName = [this.photoInfo?.make, this.photoInfo?.model].filter(Boolean).join(' ') || (track && cameraLabel(track));

    const metadata: St0601Metadata = {
      timestampUs: nowUs,
      missionId: this.options.missionId,
      platformDesignation: this.options.platformDesignation ?? 'Mobile Browser',
      imageSourceSensor: sensorName,
      sensorLatitude: position?.latitude,
      sensorLongitude: position?.longitude,
      sensorEllipsoidHeight: position?.altitude,
      horizontalFov: fov.horizontal,
      verticalFov: fov.vertical,
    };
    if (pose) {
      // The phone is both platform and sensor: carry the pointing direction as
      // platform heading plus sensor elevation/roll relative to a level platform.
      Object.assign(metadata, {
        platformHeading: pose.azimuth,
        platformPitch: 0,
        platformRoll: 0,
        sensorRelativeAzimuth: 0,
        sensorRelativeElevation: pose.elevation,
        sensorRelativeRoll: pose.roll,
      });
    }
    if (snap.footprint) {
      Object.assign(metadata, {
        slantRange: snap.footprint.slantRange,
        frameCenterLatitude: snap.footprint.center.latitude,
        frameCenterLongitude: snap.footprint.center.longitude,
        corners: snap.footprint.corners,
      });
    }
    this.muxer.writeKlv(encodeSt0601(metadata), this.encoder.nowUs());
    this.emit('metadata', snap);
  }

  private statsTimer() {
    let lastFrames = 0;
    let lastBytes = 0;
    return () => {
      if (!this.encoder || !this.transport) return;
      const frames = this.encoder.encoded;
      const bytes = this.transport.bytesSent;
      this.emit('stats', {
        fps: frames - lastFrames,
        bitrate: (bytes - lastBytes) * 8,
        targetFps: this.encoder.fps,
        targetBitrate: this.encoder.bitrate,
        transport: this.transport.kind,
        codec: this.encoder.codec,
        profile: this.encoder.profile,
        framesEncoded: frames,
        framesDropped: this.encoder.dropped,
        bytesSent: bytes,
      });
      lastFrames = frames;
      lastBytes = bytes;
    };
  }

  private fail(err: Error) {
    this.emit('error', err);
    this.setState('error');
    void this.stop();
  }

  private setState(state: StreamerState) {
    if (this.state === state) return;
    this.state = state;
    this.emit('state', state);
  }

  private emit<K extends keyof StreamerEvents>(event: K, value: StreamerEvents[K]) {
    this.listeners.get(event)?.forEach((fn) => (fn as Listener<StreamerEvents[K]>)(value));
  }
}

export function createStreamer(options: StreamerOptions): Streamer {
  return new Streamer(options);
}

export { capturePhotoWithNativeCamera, photoFov, readPhotoInfo, videoFov } from './fov';
export type { FovResult, FovSource, PhotoInfo } from './fov';
export type { CameraPose, Position } from './sensors';
export { cameraPose, rotationMatrix } from './sensors';
export { computeFootprint } from './footprint';
export type { Footprint, FootprintOptions, GroundPoint } from './footprint';
export { encodeSt0601, type St0601Metadata } from './klv/st0601';
export { TsMuxer } from './ts/muxer';
export { isEncodingSupported } from './encoder';
export { isWebTransportSupported, type WebTransportMode } from './webtransport';
