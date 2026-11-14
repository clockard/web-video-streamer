/**
 * End-to-end check of the MoQ output: headless Chromium with a fake camera and
 * microphone runs the demo page with Output = MediaMTX, which publishes over
 * Media over QUIC (WebTransport) to a local MediaMTX. The stream is read back
 * over RTSP with ffmpeg and checked with ffprobe. The camera is switched
 * mid-stream from the demo's picker and the stream must stay decodable.
 *
 *   MEDIAMTX_PATH=/path/to/mediamtx npm run e2e:moq
 *   MEDIAMTX_URL=https://127.0.0.1:8892 npm run e2e:moq   # a running MediaMTX, e.g. docker compose up
 *
 * Tested with MediaMTX v1.21.3 (MOQT draft 22).
 *
 * Environment: MEDIAMTX_PATH or MEDIAMTX_URL (one is required; with MEDIAMTX_URL,
 * RTSP is read from MEDIAMTX_RTSP_PORT, default 8554, on the same host), CHROME_PATH (browser executable),
 * STREAM_SECONDS (default 6), FALLBACK=1 (hide MediaStreamTrackProcessor to
 * test the Safari/Firefox video and audio paths), AUDIO=0 (video only).
 */
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { connect } from 'node:net';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { createServer } from 'vite';
import { startRelay } from '../packages/relay/src/server';

const MEDIAMTX = process.env.MEDIAMTX_PATH;
/** A running MediaMTX's MoQ address; otherwise one is started from MEDIAMTX_PATH. */
const EXISTING = process.env.MEDIAMTX_URL?.replace(/\/+$/, '');
const MOQ_PORT = 18892;
const RTSP_PORT = EXISTING ? Number(process.env.MEDIAMTX_RTSP_PORT || 8554) : 18554;
const RELAY_PORT = 18090; // only so the demo's relay panels have something to talk to
const STREAM_SECONDS = Number(process.env.STREAM_SECONDS || 6);
const AUDIO = process.env.AUDIO !== '0';
const DEVICE_ID = 'e2e-moq';

async function waitFor(check: () => Promise<boolean>, ms: number, what: string) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check().catch(() => false)) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** MediaMTX with only MoQ (in) and RTSP (out), certificate generated in `dir`. */
function startMediamtx(dir: string) {
  writeFileSync(
    join(dir, 'mediamtx.yml'),
    [
      'logLevel: info',
      'api: false',
      'metrics: false',
      'pprof: false',
      'playback: false',
      'rtmp: false',
      'hls: false',
      'webrtc: false',
      'srt: false',
      'rtsp: true',
      'rtspTransports: [tcp]',
      `rtspAddress: 127.0.0.1:${RTSP_PORT}`,
      'moq: true',
      `moqHTTP2Address: 127.0.0.1:${MOQ_PORT}`,
      `moqHTTP3Address: 127.0.0.1:${MOQ_PORT}`,
      'moqQUICAddress: 127.0.0.1:18893',
      'moqServerKey: auto.key',
      'moqServerCert: auto.crt',
      "moqAllowOrigins: ['*']",
      'paths:',
      '  all_others:',
      '',
    ].join('\n'),
  );
  const mediamtx = spawn(MEDIAMTX!, ['mediamtx.yml'], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
  const onLog = (b: Buffer) => b.toString().split('\n').filter(Boolean).forEach((l) => console.log(`[mediamtx] ${l}`));
  mediamtx.stdout.on('data', onLog);
  mediamtx.stderr.on('data', onLog);
  return mediamtx;
}

async function main() {
  if (!MEDIAMTX && !EXISTING) throw new Error('Set MEDIAMTX_PATH to a MediaMTX (v1.21+) executable, or MEDIAMTX_URL to a running one');

  // 1. MediaMTX: started here, or already running (MEDIAMTX_URL)
  const dir = mkdtempSync(join(tmpdir(), 'e2e-moq-'));
  const mtxUrl = EXISTING ?? `https://127.0.0.1:${MOQ_PORT}`;
  const mtxHost = new URL(mtxUrl).hostname;
  const listening = (port: number) =>
    new Promise<boolean>((r) => {
      const socket = connect(port, mtxHost, () => (socket.end(), r(true)));
      socket.on('error', () => r(false));
    });
  const mediamtx = EXISTING ? undefined : startMediamtx(dir);
  await waitFor(async () => (await listening(Number(new URL(mtxUrl).port || 443))) && (await listening(RTSP_PORT)), 10_000, 'MediaMTX');

  // 2. Demo dev server (and a relay, which this test does not stream to)
  const relay = await startRelay({ port: RELAY_PORT, webTransportPort: 14433, hostnames: ['127.0.0.1'], allow: ['127.0.0.1:*'], log: () => {} });
  process.env.RELAY_PORT = String(RELAY_PORT);
  const vite = await createServer({
    configFile: resolve(import.meta.dirname, '../packages/demo/vite.config.ts'),
    root: resolve(import.meta.dirname, '../packages/demo'),
    server: { port: 0, host: '127.0.0.1' },
    logLevel: 'warn',
  });
  await vite.listen();
  const pageUrl = vite.resolvedUrls!.local[0];

  // 3. Browser with fake camera and microphone
  const browser = await chromium.launch({
    executablePath: process.env.CHROME_PATH || undefined,
    args: ['--use-fake-device-for-media-stream=device-count=3', '--use-fake-ui-for-media-stream'],
  });
  const context = await browser.newContext({ ignoreHTTPSErrors: true, permissions: ['camera', 'microphone'] });
  const page = await context.newPage();
  if (process.env.FALLBACK) {
    await page.addInitScript(() => delete (window as { MediaStreamTrackProcessor?: unknown }).MediaStreamTrackProcessor);
  }
  page.on('console', (m) => console.log(`[page] ${m.text()}`));
  page.on('pageerror', (e) => console.log(`[page error] ${e.message}`));
  await page.goto(pageUrl);
  await page.selectOption('#output', 'moq');
  await page.fill('#moq-server', mtxUrl);
  await page.fill('#device-id', DEVICE_ID);
  await page.click('details summary'); // Options
  await page.setChecked('#audio', AUDIO);
  const demoLog = () => page.evaluate(() => [...document.querySelectorAll('#log li')].map((li) => li.textContent).reverse());

  await page.click('#start');
  await page.waitForSelector('#state[data-state="streaming"]', { timeout: 15_000 }).catch(async (err) => {
    console.error('Demo log:\n ', (await demoLog()).join('\n  '));
    throw err;
  });

  // 4. Read it back over RTSP while it streams.
  const capture = join(dir, 'rtsp.mkv');
  const rtspUrl = `rtsp://${mtxHost}:${RTSP_PORT}/${DEVICE_ID}`;
  // DESCRIBE fails (404) until MediaMTX has the published tracks.
  const described = async () => spawnSync('ffprobe', ['-v', 'error', '-rtsp_transport', 'tcp', '-i', rtspUrl], { timeout: 5000 }).status === 0;
  await waitFor(described, 15_000, 'MediaMTX to serve the stream over RTSP');
  const recorder = spawn('ffmpeg', ['-v', 'error', '-rtsp_transport', 'tcp', '-i', rtspUrl, '-c', 'copy', '-t', String(STREAM_SECONDS), '-y', capture], {
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  const recorded = new Promise<number | null>((r) => recorder.on('exit', r));

  await page.waitForTimeout((STREAM_SECONDS * 1000) / 2);
  await page.waitForSelector('#camera-row:not([hidden])', { timeout: 5000 });
  const cameras = await page.$$eval('#camera option', (os) => os.map((o) => (o as HTMLOptionElement).value).filter(Boolean));
  await page.selectOption('#camera', cameras[2]); // fake_device_2 (fake_device_1 is Y16)
  const code = await recorded;

  const panel = await page.evaluate(() =>
    Object.fromEntries(['s-transport', 's-codec', 's-audio', 's-frames', 's-fps'].map((id) => [id, document.getElementById(id)!.textContent])),
  );
  const log = await demoLog();
  await page.click('#stop');
  await page.waitForTimeout(500);
  await browser.close();
  await vite.close();
  relay.close();
  mediamtx?.kill();

  console.log('\nDemo panel:', panel);
  console.log('Demo log:\n ', log.join('\n  '));

  // 5. Check what MediaMTX served
  const failures: string[] = [];
  if (code !== 0) failures.push(`ffmpeg RTSP capture exited with ${code}`);
  const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-count_frames', '-show_streams', '-show_format', '-of', 'json', capture]).toString());
  for (const s of probe.streams) console.log(`  stream ${s.index}: ${s.codec_type} ${s.codec_name ?? ''} ${s.width ? `${s.width}x${s.height}` : ''} frames ${s.nb_read_frames ?? '?'}`);
  const video = probe.streams.find((s: { codec_name?: string }) => s.codec_name === 'h264');
  const audio = probe.streams.find((s: { codec_type?: string }) => s.codec_type === 'audio');
  if (!video) failures.push('no h264 stream over RTSP');
  else if (!(Number(video.nb_read_frames) > STREAM_SECONDS * 10)) failures.push(`only ${video.nb_read_frames} video frames over RTSP`);
  const decodeErrors = execFileSync('ffmpeg', ['-v', 'error', '-i', capture, '-map', '0:v', '-f', 'null', '-'], { stdio: ['ignore', 'pipe', 'pipe'] }).toString();
  if (decodeErrors) failures.push(`video decode errors: ${decodeErrors}`);
  if (AUDIO) {
    if (!audio) failures.push('no audio stream over RTSP');
    else if (!['aac', 'opus'].includes(audio.codec_name)) failures.push(`unexpected audio codec ${audio.codec_name}`);
  } else if (audio) failures.push('audio stream present with audio off');
  if (panel['s-transport'] !== 'moq') failures.push(`transport panel shows ${panel['s-transport']}`);
  if (log.some((l) => l?.includes('closed the connection') || l?.includes('Could not switch camera'))) failures.push('errors in demo log');
  const cameraLogs = log.filter((l) => l?.includes('Camera: '));
  if (cameraLogs.length !== 2) failures.push(`camera switch not logged: ${JSON.stringify(cameraLogs)}`);

  if (failures.length) {
    console.error('\nFAILED:\n  ' + failures.join('\n  '));
    process.exit(1);
  }
  console.log('\nE2E MoQ OK');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
