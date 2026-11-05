import { capturePhotoWithNativeCamera, createStreamer, getDeviceId, readPhotoInfo, type Streamer } from 'web-video-streamer';
import { CameraMap, fmtDistance } from './map';
import { StreamsPanel } from './streams';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const input = (id: string) => $<HTMLInputElement>(id);
const num = (id: string) => (input(id).value === '' ? undefined : Number(input(id).value));

const STORAGE_KEY = 'web-video-streamer-demo';
const fields = ['relay', 'device-id', 'device-name', 'admin-token', 'transport', 'wt-mode', 'wt-url', 'width', 'height', 'fps', 'bitrate', 'declination', 'mission', 'height-agl', 'max-range'];

function loadSettings() {
  input('relay').value = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/relay`;
  input('device-id').value = getDeviceId().id;
  input('wt-url').value = `https://${location.hostname === 'localhost' ? '127.0.0.1' : location.hostname}:4433/stream`;
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as Record<string, string>;
    for (const f of fields) if (saved[f]) input(f).value = saved[f];
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
    localStorage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(fields.map((f) => [f, input(f).value]))));
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
    width: num('width'),
    height: num('height'),
    fps: num('fps'),
    bitrate: bitrateSetting(),
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

if (!window.isSecureContext) log('This page is not served over HTTPS; camera and sensors will be unavailable.', 'error');
loadSettings();

const streams = new StreamsPanel(
  $<HTMLOListElement>('streams'),
  $('streams-status'),
  '/relay',
  () => input('device-id').value,
  () => input('admin-token').value,
);
streams.start();
$('streams-refresh').addEventListener('click', () => void streams.refresh());
input('admin-token').addEventListener('change', () => {
  saveSettings();
  void streams.refresh();
});
