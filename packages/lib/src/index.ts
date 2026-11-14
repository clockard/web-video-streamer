/**
 * web-video-streamer — stream a browser camera (and microphone) as MPEG-TS
 * with MISB ST 0601 KLV metadata. Browsers cannot send UDP, so the transport stream is sent
 * over WebTransport or a WebSocket to a relay (see web-video-streamer-relay).
 * The library identifies the device; the relay decides which UDP output each
 * device's stream goes to.
 *
 * Alternatively (output: 'moq') video and audio are published straight to a
 * Media over QUIC server such as MediaMTX, without the relay and without KLV.
 */
import {
  cameraLabel,
  isMissingCameraError,
  openCamera,
  trackZoom,
  videoConstraints,
  type CameraInfo,
  type CameraOptions,
  type CameraSelection,
} from './camera';
import { FrameEncoder, isEncodingSupported } from './encoder';
import { audioConstraints, AudioEncoderPipeline, isAudioEncodingSupported, type AudioOptions } from './audio';
import { StreamClock } from './clock';
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
import { getDeviceId } from './device';
import { relayUrl, WebSocketTransport, type Transport, type TransportEvents } from './transport';
import { isWebTransportSupported, WebTransportTransport, type WebTransportMode } from './webtransport';
import { MoqPublisher } from './moq/publisher';
import { avc3Codec, type MoqAudioTrack, type MoqTracks } from './moq/catalog';
import type { MoqCredentials } from './moq/messages';
import { MoqSink, TsSink, type MediaSink } from './sink';

export interface StreamerOptions extends CameraOptions {
  /**
   * 'relay' (default): MPEG-TS with KLV metadata to the relay, which forwards it as UDP.
   * 'moq': video and audio straight to a Media over QUIC server (MediaMTX) at moqUrl, no KLV.
   */
  output?: 'relay' | 'moq';
  /**
   * MoQ (WebTransport) URL of the stream, e.g. "https://mediamtx.example.com:8892/phone-chris":
   * MediaMTX publishes it under the path in the URL. Required when output is 'moq'.
   */
  moqUrl?: string;
  /**
   * Where to fetch the hex SHA-256 of a self-signed MoQ server certificate. Default
   * `<moqUrl>/fingerprint`, which MediaMTX serves; false when the server's certificate is publicly trusted.
   */
  moqFingerprintUrl?: string | false;
  /** MediaMTX credentials: user and password, or a bearer token. */
  moqCredentials?: MoqCredentials;
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
  /**
   * Identifies this device to the relay, which maps it to a UDP output (the same
   * device always gets the same output). Default: a random ID generated once and
   * kept in localStorage (see getDeviceId).
   */
  deviceId?: string;
  /** Human-readable label shown in the relay's stream list. */
  deviceName?: string;
  /**
   * Include microphone audio (default true): AAC where the browser can encode
   * it, otherwise Opus. Pass options to tune it, or false for video only. If the
   * microphone or audio encoding is unavailable, a warning is emitted and the
   * stream carries video only.
   */
  audio?: boolean | AudioOptions;
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
  /** Transport in use, e.g. "webtransport/datagram", "websocket" or "moq". */
  transport?: string;
  /** Codec string and H.264 profile in use, e.g. "avc1.64001F" / "High". */
  codec?: string;
  profile?: string;
  framesEncoded: number;
  framesDropped: number;
  bytesSent: number;
  /** Audio codec in the stream ("aac" or "opus"), or undefined without audio. */
  audioCodec?: string;
  /** Audio encoder bitrate (bits/s). */
  audioBitrate?: number;
  audioFramesEncoded: number;
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
  /** The camera in use: on start and after each switch (setCamera). */
  camera: CameraInfo;
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
  /** The ID this streamer identifies itself to the relay with. */
  readonly deviceId: string;

  private readonly listeners = new Map<keyof StreamerEvents, Set<Listener<never>>>();
  private sensors?: SensorTracker;
  private encoder?: FrameEncoder;
  private audio?: AudioEncoderPipeline;
  private sink?: MediaSink;
  private timers: ReturnType<typeof setInterval>[] = [];
  private photoInfo?: PhotoInfo;
  private fovSource: FovSource = 'default';
  /** Lens data per camera ID: each camera of a multi-camera phone has its own focal length. */
  private readonly lensByCamera = new Map<string, { info: PhotoInfo; source: FovSource }>();
  private switching?: Promise<void>;
  private frameSize = { width: 0, height: 0 };
  private videoStarted = false;
  private readonly devicePersistent: boolean;

  private readonly options: StreamerOptions;

  constructor(options: StreamerOptions) {
    // Copied so setBitrate/setFrameRate don't modify the caller's object.
    this.options = { ...options };
    const device = options.deviceId ? { id: options.deviceId, persistent: true } : getDeviceId();
    this.deviceId = device.id;
    this.devicePersistent = device.persistent;
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
    if (!this.devicePersistent) {
      this.emit('warning', 'Storage is unavailable, so this device ID only lasts for this page; the relay may assign a new output next time');
    }

    try {
      if (!isEncodingSupported()) throw new Error('This browser does not support WebCodecs video encoding');
      if (this.options.output === 'moq') {
        if (!this.options.moqUrl) throw new Error('moqUrl is required for MoQ output');
        if (!isWebTransportSupported()) throw new Error('This browser does not support WebTransport, which MoQ needs');
      }

      const audioOptions = this.audioOptions();
      this.stream = await this.openMedia(audioOptions);
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

      this.lensByCamera.clear();
      await this.initFov(track, true);
      this.emitCamera(track);

      const clock = new StreamClock();
      // The audio codec must be known before the sink is made: it goes in the PMT / catalog.
      this.audio = await this.prepareAudio(audioOptions, clock);
      this.sink = await this.connectSink();

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
          this.sink?.writeVideo(frame);
        },
        (err) => this.fail(err),
        () => this.sink?.bufferedAmount ?? 0,
        clock,
      );
      this.encoder.onFrameSize = (width, height) => {
        this.frameSize = { width, height };
        const current = this.videoTrack;
        if (current) this.updateFov(current);
      };
      await this.encoder.start(this.options.videoElement);
      this.audio?.start();

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
    await Promise.all([this.encoder?.stop(), this.audio?.stop()]);
    this.sink?.close();
    this.sensors?.stop();
    this.stream?.getTracks().forEach((t) => t.stop());
    if (this.options.videoElement) this.options.videoElement.srcObject = null;
    this.encoder = this.audio = this.sink = this.sensors = undefined;
    this.stream = undefined;
    if (this.state !== 'error') this.setState('stopped');
  }

  /** Transport in use while streaming, e.g. "webtransport/datagram", "websocket" or "moq". */
  get transportKind(): string | undefined {
    return this.sink?.kind;
  }

  /** Audio settings, or undefined when audio is off or cannot work in this browser. */
  private audioOptions(): AudioOptions | undefined {
    const audio = this.options.audio ?? true;
    if (audio === false) return undefined;
    if (!isAudioEncodingSupported()) {
      this.emit('warning', 'This browser does not support WebCodecs audio encoding; streaming without audio');
      return undefined;
    }
    return audio === true ? {} : audio;
  }

  /** Open camera and microphone. A requested camera that doesn't exist falls back to the default one. */
  private async openMedia(audio: AudioOptions | undefined): Promise<MediaStream> {
    try {
      return await this.openCameraAndMicrophone(audio, this.options);
    } catch (err) {
      if (!this.options.cameraId || !isMissingCameraError(err)) throw err;
      this.emit('warning', `Camera ${this.options.cameraId} is not available; using the default camera`);
      this.options.cameraId = undefined;
      return this.openCameraAndMicrophone(audio, this.options);
    }
  }

  /** If only the microphone fails, carry on with the camera alone. */
  private async openCameraAndMicrophone(audio: AudioOptions | undefined, camera: CameraOptions): Promise<MediaStream> {
    if (!audio) return openCamera(camera);
    try {
      return await openCamera(camera, audioConstraints(audio));
    } catch (err) {
      const name = (err as DOMException).name;
      if (!['NotAllowedError', 'NotFoundError', 'NotReadableError', 'OverconstrainedError', 'AbortError'].includes(name)) throw err;
      const stream = await openCamera(camera);
      this.emit('warning', `Microphone unavailable (${(err as Error).message || name}); streaming without audio`);
      return stream;
    }
  }

  private get videoTrack(): MediaStreamTrack | undefined {
    return this.stream?.getVideoTracks()[0];
  }

  /** The camera in use while streaming. */
  get camera(): CameraInfo | undefined {
    const track = this.videoTrack;
    return track && this.cameraInfo(track);
  }

  private cameraInfo(track: MediaStreamTrack): CameraInfo {
    const settings = track.getSettings();
    const facing = settings.facingMode === 'environment' || settings.facingMode === 'user' ? settings.facingMode : undefined;
    return { id: settings.deviceId ?? '', label: track.label, facing };
  }

  private emitCamera(track: MediaStreamTrack) {
    this.emit('camera', this.cameraInfo(track));
  }

  /**
   * Choose the camera: by ID (see listCameras()) or facing direction; `{}` returns to the default
   * (rear) camera. While streaming, switches immediately without interrupting the stream: the
   * receiver sees a keyframe from the new camera, and the FOV is re-estimated for its lens.
   * Otherwise it applies at the next start. Rejects (keeping the current camera) if the camera
   * cannot be opened.
   */
  async setCamera(selection: CameraSelection): Promise<void> {
    const previous = this.switching;
    const run = (async () => {
      await previous?.catch(() => {});
      await this.switchCamera(selection);
    })();
    this.switching = run;
    try {
      await run;
    } finally {
      if (this.switching === run) this.switching = undefined;
    }
  }

  private async switchCamera(selection: CameraSelection) {
    const camera: CameraOptions = { ...this.options, cameraId: selection.cameraId, facingMode: selection.facingMode };
    const stream = this.stream;
    const old = this.videoTrack;
    if (!stream || !old || !this.encoder || (this.state !== 'streaming' && this.state !== 'reconnecting')) {
      this.options.cameraId = camera.cameraId;
      this.options.facingMode = camera.facingMode;
      return;
    }
    if (selection.cameraId && selection.cameraId === old.getSettings().deviceId) return;

    const open = async () => (await navigator.mediaDevices.getUserMedia({ video: videoConstraints(camera) })).getVideoTracks()[0];
    let track: MediaStreamTrack;
    try {
      track = await open();
    } catch (err) {
      // Many phones can only open one camera at a time: release the current one and try again.
      if ((err as DOMException).name !== 'NotReadableError' && (err as DOMException).name !== 'AbortError') throw err;
      await this.encoder.detach();
      old.stop();
      try {
        track = await open();
      } catch (retryErr) {
        // Get the previous camera back so the stream carries on.
        try {
          const restored = (await navigator.mediaDevices.getUserMedia({ video: videoConstraints({ ...this.options, cameraId: old.getSettings().deviceId }) })).getVideoTracks()[0];
          await this.useTrack(stream, old, restored);
        } catch {
          this.fail(new Error(`Camera switch failed and the previous camera could not be reopened: ${(retryErr as Error).message}`));
        }
        throw retryErr;
      }
    }
    // The stream may have stopped while the camera was opening.
    if (this.stream !== stream || !this.encoder) {
      track.stop();
      return;
    }
    this.options.cameraId = camera.cameraId;
    this.options.facingMode = camera.facingMode;
    await this.useTrack(stream, old, track);

    const settings = track.getSettings();
    this.frameSize = { width: settings.width ?? this.frameSize.width, height: settings.height ?? this.frameSize.height };
    await this.initFov(track, false);
    this.emitCamera(track);
  }

  /** Put a new video track in place of the old one: preview, encoder and stream. */
  private async useTrack(stream: MediaStream, old: MediaStreamTrack, track: MediaStreamTrack) {
    await this.encoder?.detach();
    stream.removeTrack(old);
    old.stop();
    stream.addTrack(track);
    const video = this.options.videoElement;
    if (video) {
      video.srcObject = stream;
      void video.play().catch(() => {});
    }
    this.encoder?.setTrack(track);
  }

  /** Set up audio encoding for the stream's microphone track, or warn and drop the track. */
  private async prepareAudio(options: AudioOptions | undefined, clock: StreamClock): Promise<AudioEncoderPipeline | undefined> {
    const track = this.stream?.getAudioTracks()[0];
    if (!options || !track) return undefined;
    // Audio waits for the first video frame, which brings PAT/PMT (or the MoQ catalog) and a keyframe.
    const pipeline = new AudioEncoderPipeline(
      track,
      options,
      clock,
      (frame) => this.videoStarted && this.sink?.writeAudio(frame),
      (err) => {
        // Losing audio is not worth losing the stream: keep sending video.
        this.emit('warning', `Audio stopped: ${err.message}`);
        if (this.audio === pipeline) this.audio = undefined;
        void pipeline.stop();
        track.stop();
      },
    );
    try {
      await pipeline.prepare();
      return pipeline;
    } catch (err) {
      this.emit('warning', `${(err as Error).message}; streaming without audio`);
      track.stop();
      this.stream?.removeTrack(track);
      return undefined;
    }
  }

  /** Connect the configured output: MoQ, or the relay as MPEG-TS. */
  private async connectSink(): Promise<MediaSink> {
    if (this.options.output !== 'moq') return new TsSink(await this.connectTransport(this.transportEvents('Relay')), this.audio?.muxConfig);
    const publisher = new MoqPublisher(
      {
        url: this.options.moqUrl!,
        fingerprintUrl: this.options.moqFingerprintUrl,
        credentials: this.options.moqCredentials,
        tracks: () => this.moqTracks(),
      },
      this.transportEvents('MoQ server'),
    );
    await publisher.connect();
    return new MoqSink(publisher);
  }

  /** What the MoQ catalog announces; undefined until the video encoder is configured. */
  private moqTracks(): MoqTracks | undefined {
    const codec = this.encoder?.codec;
    if (!codec) return undefined;
    const audio = this.audio;
    const audioCodec = audio?.codecString;
    const audioTrack: MoqAudioTrack | undefined = audio && audioCodec ? { codec: audioCodec, sampleRate: audio.sampleRate, channels: audio.channelCount } : undefined;
    return { video: { codec: avc3Codec(codec) }, audio: audioTrack };
  }

  private transportEvents(peer: string): TransportEvents {
    return {
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
          this.fail(new Error(`${peer} closed the connection: ${reason}`));
        }
      },
    };
  }

  /** Connect to the relay with the configured transport, falling back from WebTransport to WebSocket in 'auto'. */
  private async connectTransport(events: TransportEvents): Promise<Transport> {
    const { transport: choice = 'auto', webTransportUrl, relayUrl: wsUrl, deviceName } = this.options;

    if (choice === 'webtransport' || (choice === 'auto' && webTransportUrl)) {
      if (!isWebTransportSupported()) {
        if (choice === 'webtransport') throw new Error('This browser does not support WebTransport');
        this.emit('warning', 'This browser does not support WebTransport; using WebSocket');
      } else if (!webTransportUrl) {
        throw new Error('webTransportUrl is required for WebTransport');
      } else {
        const wt = new WebTransportTransport(
          webTransportUrl,
          {
            mode: this.options.webTransportMode ?? 'datagram',
            deviceId: this.deviceId,
            deviceName,
            serverCertificateHash: this.options.serverCertificateHash,
          },
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
    const ws = new WebSocketTransport(relayUrl(wsUrl, this.deviceId, deviceName), events);
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

  /**
   * Find the lens data for this camera and compute the FOV. The calibration photo (taken with
   * the native camera app's rear camera) is only used for the camera the stream starts with,
   * unless that is a front camera.
   */
  private async initFov(track: MediaStreamTrack, starting: boolean) {
    const settings = track.getSettings();
    if (starting) this.frameSize = { width: settings.width ?? 1280, height: settings.height ?? 720 };
    const cameraId = settings.deviceId ?? '';
    const known = this.lensByCamera.get(cameraId);
    if (known) {
      this.photoInfo = known.info;
      this.fovSource = known.source;
      this.updateFov(track);
      return;
    }

    this.photoInfo = undefined;
    let source: FovSource = 'default';
    if (starting && this.options.calibrationPhoto && settings.facingMode !== 'user') {
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
    this.lensByCamera.set(cameraId, { info: this.photoInfo, source: this.fovSource });
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
    if (!snap || !this.sink || !this.encoder || !this.videoStarted) return;
    if (!this.sink.writeKlv) {
      // This output carries no KLV; the snapshot still drives the page.
      this.emit('metadata', snap);
      return;
    }
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
    this.sink.writeKlv(encodeSt0601(metadata), this.encoder.nowUs());
    this.emit('metadata', snap);
  }

  private statsTimer() {
    let lastFrames = 0;
    let lastBytes = 0;
    return () => {
      if (!this.encoder || !this.sink) return;
      const frames = this.encoder.encoded;
      const bytes = this.sink.bytesSent;
      this.emit('stats', {
        fps: frames - lastFrames,
        bitrate: (bytes - lastBytes) * 8,
        targetFps: this.encoder.fps,
        targetBitrate: this.encoder.bitrate,
        transport: this.sink.kind,
        codec: this.encoder.codec,
        profile: this.encoder.profile,
        framesEncoded: frames,
        framesDropped: this.encoder.dropped,
        bytesSent: bytes,
        audioCodec: this.audio?.codec,
        audioBitrate: this.audio?.bitrate,
        audioFramesEncoded: this.audio?.encoded ?? 0,
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
export { decodeSt0601, encodeSt0601, type St0601Metadata } from './klv/st0601';
export { TsDemuxer, type DemuxedAudioCodec, type DemuxedProgram, type DemuxedSample, type ElementaryKind, type TsDemuxerOptions } from './ts/demuxer';
export { createPlayer, h264CodecFromSps, isPlaybackSupported, StreamPlayer, type PlayerOptions, type PlayerState, type PlayerStats } from './player';
export { TsMuxer, type AudioCodec, type MuxerAudioConfig } from './ts/muxer';
export { isEncodingSupported } from './encoder';
export { isAudioEncodingSupported, type AudioOptions } from './audio';
export { getDeviceId } from './device';
export { listCameras, type CameraInfo, type CameraOptions, type CameraSelection } from './camera';
export { isWebTransportSupported, type WebTransportMode } from './webtransport';
export { MoqPublisher, type MoqPublisherOptions } from './moq/publisher';
export type { MoqAudioTrack, MoqTracks, MoqVideoTrack } from './moq/catalog';
export type { MoqCredentials } from './moq/messages';

/** MoQ output needs WebTransport (and WebCodecs, like every output). */
export function isMoqSupported(): boolean {
  return isWebTransportSupported() && isEncodingSupported();
}
