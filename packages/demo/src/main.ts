import {
  capturePhotoWithNativeCamera,
  createPlayer,
  createStreamer,
  getDeviceId,
  isPlaybackSupported,
  listCameras,
  readPhotoInfo,
  type StreamPlayer,
  type Streamer,
} from 'web-video-streamer';
import { CameraMap, fmtDistance } from './map';
import { StreamsPanel } from './streams';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const input = (id: string) => $<HTMLInputElement>(id);
const num = (id: string) => (input(id).value === '' ? undefined : Number(input(id).value));

const STORAGE_KEY = 'web-video-streamer-demo';
const fields = ['relay', 'device-id', 'device-name', 'admin-token', 'transport', 'wt-mode', 'wt-url', 'width', 'height', 'fps', 'bitrate', 'declination', 'mission', 'height-agl', 'max-range', 'audio', 'camera'];

/**
 * The chosen camera's ID ('' = default). Kept apart from the <select>, whose options only
 * exist once the browser reveals the cameras (after camera permission).
 */
let preferredCamera = '';

/** A field's saved form: checkboxes as "on"/"off", everything else as its value. */
const fieldValue = (f: string) =>
  f === 'camera' ? preferredCamera : input(f).type === 'checkbox' ? (input(f).checked ? 'on' : 'off') : input(f).value;
function setField(f: string, value: string) {
  if (f === 'camera') preferredCamera = value;
  else if (input(f).type === 'checkbox') input(f).checked = value === 'on';
  else input(f).value = value;
}

function loadSettings() {
  input('relay').value = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/relay`;
  input('device-id').value = getDeviceId().id;
  input('wt-url').value = `https://${location.hostname === 'localhost' ? '127.0.0.1' : location.hostname}:4433/stream`;
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as Record<string, string>;
    for (const f of fields) if (saved[f]) setField(f, saved[f]);
  } catch {
    // Storage unavailable (private mode); defaults are fine.
  }
  showVideoSettings();
}

/** Bitrate slider in kbps; 0 means automatic. */
const bitrateSetting = () => (Number(input('bitrate').value) > 0 ? Number(input('bitrate').value) * 1000 : undefined);

function showVideoSettings() {
  $('fps-out').textContent = `${input('fps').value} fps`;
  const bitrate = bitrateSetting();
  $('bitrate-out').textContent = bitrate ? `${bitrate / 1000} kbps` : 'auto';
}

// Apply slider changes live while streaming; they are also used at the next start.
input('fps').addEventListener('input', showVideoSettings);
input('bitrate').addEventListener('input', showVideoSettings);
input('fps').addEventListener('change', () => {
  saveSettings();
  if (!streamer) return;
  streamer.setFrameRate(Number(input('fps').value));
  log(`Frame rate limit set to ${input('fps').value} fps`);
});
const footprintSettings = () => ({ heightAboveGround: num('height-agl'), maxRange: num('max-range') });
for (const id of ['height-agl', 'max-range']) {
  input(id).addEventListener('change', () => {
    saveSettings();
    streamer?.setFootprintOptions(footprintSettings());
  });
}

input('bitrate').addEventListener('change', () => {
  saveSettings();
  if (!streamer) return;
  streamer.setBitrate(bitrateSetting());
  log(`Bitrate set to ${$('bitrate-out').textContent}`);
});

function saveSettings() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(fields.map((f) => [f, fieldValue(f)]))));
  } catch {
    // Ignore storage failures.
  }
}

function log(message: string, level: 'info' | 'warning' | 'error' = 'info') {
  const li = document.createElement('li');
  li.className = level;
  li.textContent = `${new Date().toLocaleTimeString()} ${message}`;
  $('log').prepend(li);
}

/**
 * WebTransport URL, with "localhost" replaced by 127.0.0.1. Browsers try ::1
 * first for localhost and, unlike TCP, QUIC does not fall back to IPv4, so a
 * relay unreachable over IPv6 loopback (e.g. WSL mirrored networking) fails.
 */
function webTransportUrl(): string | undefined {
  const value = input('wt-url').value.trim();
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (url.hostname !== 'localhost') return value;
    url.hostname = '127.0.0.1';
    input('wt-url').value = url.toString();
    log(`WebTransport URL uses 127.0.0.1 instead of localhost (QUIC does not fall back from IPv6 ::1)`);
    return url.toString();
  } catch {
    return value;
  }
}

const fmt = (v: number | undefined, digits: number, unit = '') => (v === undefined ? '—' : `${v.toFixed(digits)}${unit}`);

// Fetched up front: an await in the Start click handler would cost iOS the user
// gesture it needs for the motion-sensor permission prompt.
let certificateHash: string | undefined;
fetch('/relay/cert-hash')
  .then((r) => (r.ok ? r.json() : undefined))
  .then((body?: { sha256?: string }) => (certificateHash = body?.sha256))
  .catch(() => log('Relay certificate hash unavailable; WebTransport needs a trusted certificate', 'warning'));

let calibrationPhoto: File | undefined;
let streamer: Streamer | undefined;
let mapTimer: ReturnType<typeof setInterval> | undefined;
const map = new CameraMap($('map'));

$('calibrate').addEventListener('click', async () => {
  // Opens the native camera app; must run directly in the click handler.
  const file = await capturePhotoWithNativeCamera();
  if (!file) return;
  const info = await readPhotoInfo(file).catch(() => ({}) as Awaited<ReturnType<typeof readPhotoInfo>>);
  if (info.focalLength35mm) {
    calibrationPhoto = file;
    $('calibration').textContent = `Calibrated: ${[info.make, info.model].filter(Boolean).join(' ') || 'camera'}, ${info.focalLength35mm} mm (35mm equiv.)`;
    log(`Calibration photo read: ${info.focalLength35mm} mm equivalent`);
  } else {
    calibrationPhoto = undefined;
    $('calibration').textContent = 'That photo had no 35mm focal length in its EXIF data; FOV will use defaults.';
    log('Calibration photo has no FocalLengthIn35mmFilm EXIF tag', 'warning');
  }
});

$('config').addEventListener('submit', async (e) => {
  e.preventDefault();
  saveSettings();

  streamer = createStreamer({
    relayUrl: input('relay').value,
    transport: input('transport').value as 'auto' | 'webtransport' | 'websocket',
    webTransportUrl: webTransportUrl(),
    webTransportMode: input('wt-mode').value as 'datagram' | 'stream',
    serverCertificateHash: certificateHash,
    deviceId: input('device-id').value || undefined,
    deviceName: input('device-name').value || undefined,
    cameraId: preferredCamera || undefined,
    width: num('width'),
    height: num('height'),
    fps: num('fps'),
    bitrate: bitrateSetting(),
    audio: input('audio').checked,
    declination: num('declination'),
    footprint: footprintSettings(),
    missionId: input('mission').value || undefined,
    calibrationPhoto,
    videoElement: $<HTMLVideoElement>('preview'),
  });

  streamer.on('state', (state) => {
    $('state').textContent = state;
    $('state').dataset.state = state;
    const active = state === 'initializing' || state === 'streaming' || state === 'reconnecting';
    $('start').hidden = active;
    $('stop').hidden = !active;
    $<HTMLButtonElement>('calibrate').disabled = active;
    $('overlay').hidden = state !== 'streaming';
    log(`State: ${state}`);
    setKeepAwake(active);

    // The map follows the sensors more often than the 1 Hz KLV rate.
    clearInterval(mapTimer);
    if (active) {
      const s = streamer;
      mapTimer = setInterval(() => {
        const snap = s?.snapshot();
        if (!snap) return;
        map.update(snap);
        const f = snap.footprint;
        $('m-center').textContent = f
          ? `${f.center.capped ? '≥' : ''}${fmtDistance(f.center.distance)} / ${fmtDistance(f.slantRange)}`
          : 'needs position + compass heading';
      }, 250);
    }
  });
  streamer.on('camera', (camera) => {
    log(`Camera: ${camera.label || 'unnamed'}`);
    // Permission is granted now, so the browser reveals every camera's ID and label.
    void refreshCameras();
  });
  streamer.on('warning', (msg) => log(msg, 'warning'));
  streamer.on('error', (err) => log(err.message, 'error'));
  streamer.on('fov', (fov) => {
    $('m-fov').textContent = `${fov.horizontal.toFixed(1)}° × ${fov.vertical.toFixed(1)}° (${fov.source})`;
    $('m-camera').textContent =
      [fov.make, fov.model].filter(Boolean).join(' ') + (fov.focalLength35mm ? ` ${fov.focalLength35mm} mm eq.` : '') || '—';
  });
  streamer.on('metadata', ({ position, pose }) => {
    $('m-pos').textContent = position
      ? `${position.latitude.toFixed(6)}, ${position.longitude.toFixed(6)} ±${position.accuracy.toFixed(0)} m`
      : 'waiting for GPS…';
    $('m-alt').textContent = fmt(position?.altitude, 1, ' m');
    $('m-pose').textContent = pose
      ? `${pose.azimuth.toFixed(1)}° / ${pose.elevation.toFixed(1)}° / ${pose.roll.toFixed(1)}°${pose.absolute ? '' : ' (relative)'}`
      : 'no orientation sensor';
    $('overlay').textContent = pose ? `AZ ${pose.azimuth.toFixed(0)}°  EL ${pose.elevation.toFixed(0)}°` : 'KLV sending';
  });
  streamer.on('stats', (s) => {
    $('s-fps').textContent = `${s.fps} / ${s.targetFps} fps`;
    $('s-bitrate').textContent =
      `${(s.bitrate / 1000).toFixed(0)}` + (s.targetBitrate ? ` / ${(s.targetBitrate / 1000).toFixed(0)}` : '') + ' kbps';
    $('s-transport').textContent = s.transport ?? '—';
    $('s-codec').textContent = s.codec ? `H.264 ${s.profile} (${s.codec})` : '—';
    $('s-audio').textContent = s.audioCodec
      ? `${s.audioCodec === 'aac' ? 'AAC' : 'Opus'}${s.audioBitrate ? ` ${(s.audioBitrate / 1000).toFixed(0)} kbps` : ''}, ${s.audioFramesEncoded} frames`
      : 'off';
    $('s-frames').textContent = `${s.framesEncoded} / ${s.framesDropped}`;
    $('s-sent').textContent = `${(s.bytesSent / 1e6).toFixed(1)} MB`;
  });

  try {
    await streamer.start();
  } catch {
    // Reported through the error event.
  }
});

$('stop').addEventListener('click', () => void streamer?.stop());

// Keep the screen on while streaming. The browser releases the wake lock whenever the page is
// hidden, so it is re-requested when the page becomes visible again.
let keepAwake = false;
let wakeLock: WakeLockSentinel | undefined;
let wakeLockWarned = false;

function setKeepAwake(on: boolean) {
  keepAwake = on;
  if (on) void acquireWakeLock();
  else {
    void wakeLock?.release().catch(() => {});
    wakeLock = undefined;
  }
}

async function acquireWakeLock() {
  if (!keepAwake || (wakeLock && !wakeLock.released) || document.visibilityState !== 'visible') return;
  if (!('wakeLock' in navigator)) {
    if (!wakeLockWarned) log('Screen wake lock not supported; the screen may turn off while streaming', 'warning');
    wakeLockWarned = true;
    return;
  }
  try {
    const sentinel = await navigator.wakeLock.request('screen');
    if (!keepAwake) {
      void sentinel.release();
      return;
    }
    wakeLock = sentinel;
  } catch (err) {
    log(`Screen wake lock unavailable: ${(err as Error).message}`, 'warning');
  }
}

document.addEventListener('visibilitychange', () => void acquireWakeLock());

// ---- Camera choice ----

async function refreshCameras() {
  const cameras = await listCameras().catch(() => []);
  const select = $<HTMLSelectElement>('camera');
  const facing = { environment: 'rear', user: 'front' } as const;
  select.replaceChildren(
    new Option('Default (rear camera)', ''),
    ...cameras.map((c, i) => new Option(`${c.label || `Camera ${i + 1}`}${c.facing && !c.label ? ` (${facing[c.facing]})` : ''}`, c.id)),
  );
  // A remembered camera that is gone (or not revealed yet) shows as the default.
  select.value = cameras.some((c) => c.id === preferredCamera) ? preferredCamera : '';
  $('camera-row').hidden = cameras.length < 2;
}

$('camera').addEventListener('change', async () => {
  const select = $<HTMLSelectElement>('camera');
  preferredCamera = select.value;
  saveSettings();
  if (!streamer || (streamer.state !== 'streaming' && streamer.state !== 'reconnecting')) return;
  select.disabled = true;
  try {
    await streamer.setCamera({ cameraId: preferredCamera || undefined });
  } catch (err) {
    log(`Could not switch camera: ${(err as Error).message}`, 'error');
    void refreshCameras();
  } finally {
    select.disabled = false;
  }
});

navigator.mediaDevices?.addEventListener?.('devicechange', () => void refreshCameras());

if (!window.isSecureContext) log('This page is not served over HTTPS; camera and sensors will be unavailable.', 'error');
loadSettings();
void refreshCameras();

const streams = new StreamsPanel(
  $<HTMLOListElement>('streams'),
  $('streams-status'),
  '/relay',
  () => input('device-id').value,
  () => input('admin-token').value,
  watch,
);
streams.start();
$('streams-refresh').addEventListener('click', () => void streams.refresh());
input('admin-token').addEventListener('change', () => {
  saveSettings();
  void streams.refresh();
});

// ---- Watching another device's stream ----

let player: StreamPlayer | undefined;
let audioContext: AudioContext | undefined;

/** Watch a device's stream from the relay. Runs in the Watch button's click handler. */
function watch(deviceId: string, name?: string) {
  if (!isPlaybackSupported()) {
    log('This browser cannot decode video (WebCodecs VideoDecoder is unavailable), so it cannot watch streams', 'error');
    return;
  }
  stopWatching();
  // Created (or resumed) inside the click so the browser lets it play sound.
  audioContext ??= new AudioContext({ latencyHint: 'interactive' });
  void audioContext.resume().catch(() => {});

  const label = name ? `${name} (${deviceId})` : deviceId;
  const params = new URLSearchParams({ device: deviceId });
  if (input('admin-token').value) params.set('token', input('admin-token').value);
  const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/relay/watch?${params}`;

  const p = createPlayer({
    url,
    canvas: $<HTMLCanvasElement>('viewer-canvas'),
    audioContext,
    muted: input('viewer-muted').checked,
  });
  player = p;
  $('viewer').hidden = false;
  $('viewer-title').textContent = `Watching ${label}`;
  for (const id of ['v-fps', 'v-bitrate', 'v-codec', 'v-audio', 'v-frames', 'v-pos']) $(id).textContent = '—';

  p.on('state', (state) => {
    $('viewer-state').textContent = state === 'waiting' ? 'device offline' : state;
    $('viewer-state').dataset.state = state;
    log(`Watching ${deviceId}: ${state === 'waiting' ? 'device offline, waiting for it' : state}`);
  });
  p.on('warning', (msg) => log(`Watching ${deviceId}: ${msg}`, 'warning'));
  p.on('error', (err) => log(`Watching ${deviceId}: ${err.message}`, 'error'));
  p.on('stats', (s) => {
    $('v-fps').textContent = `${s.fps} fps`;
    $('v-bitrate').textContent = `${(s.bitrate / 1000).toFixed(0)} kbps`;
    $('v-codec').textContent = s.codec ? `${s.codec}${s.width ? ` ${s.width}×${s.height}` : ''}` : '—';
    $('v-audio').textContent = s.audioCodec ? `${s.audioCodec === 'aac' ? 'AAC' : 'Opus'}, ${s.audioFramesDecoded} frames` : 'none';
    $('v-frames').textContent = `${s.framesDecoded} / ${s.framesDropped}`;
  });
  p.on('metadata', (m) => {
    $('v-pos').textContent =
      m.sensorLatitude !== undefined && m.sensorLongitude !== undefined
        ? `${m.sensorLatitude.toFixed(6)}, ${m.sensorLongitude.toFixed(6)}`
        : 'no position';
    map.updateRemote(name || deviceId, m);
  });
  p.start();
}

function stopWatching() {
  player?.stop();
  player = undefined;
  map.clearRemote();
}

$('viewer-stop').addEventListener('click', () => {
  stopWatching();
  $('viewer').hidden = true;
});
input('viewer-muted').addEventListener('change', () => player?.setMuted(input('viewer-muted').checked));
