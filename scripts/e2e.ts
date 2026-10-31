/**
 * End-to-end check: headless Chromium with a fake camera runs the demo page,
 * which streams through the Vite /relay proxy to the relay, which sends UDP to
 * a local socket. The captured transport stream is checked with ffprobe and
 * its KLV packets are parsed. The device's UDP output is set through the
 * relay's /streams API before starting, then changed mid-stream from the
 * demo's "Relay streams" panel and a second socket must receive the stream.
 *
 *   npm run e2e
 *
 * Environment: CHROME_PATH (browser executable), STREAM_SECONDS (default 6),
 * FALLBACK=1 (hide MediaStreamTrackProcessor to test the Safari/Firefox frame path),
 * SCREENSHOT=path.png (save a screenshot of the demo page before stopping),
 * TRANSPORT=auto|webtransport|websocket (default auto), WT_MODE=datagram|stream,
 * WT_BROKEN=1 (unreachable WebTransport URL, to test the fallback to WebSocket).
 */
import { execFileSync } from 'node:child_process';
import { createSocket } from 'node:dgram';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { createServer } from 'vite';
import misb from '@vidterra/misb.js';
import { startRelay } from '../packages/relay/src/server';

const RELAY_PORT = 18090;
const WT_PORT = 14433;
/** auto | webtransport | websocket */
const TRANSPORT = process.env.TRANSPORT || 'auto';
const WT_MODE = process.env.WT_MODE || 'datagram';
/** Point WebTransport at a closed port to check the auto fallback to WebSocket. */
const WT_BROKEN = !!process.env.WT_BROKEN;
const STREAM_SECONDS = Number(process.env.STREAM_SECONDS || 6);
const LOCATION = { latitude: 38.8895, longitude: -77.0353 };
const LIVE_FPS = 10;
const LIVE_BITRATE_KBPS = 1000;
const DEVICE_ID = 'e2e-device';
const ORIENTATION = { alpha: 315, beta: 80, gamma: 0 }; // facing north-east (45°), tilted 10° down

const pidOf = (p: Buffer) => ((p[1] & 0x1f) << 8) | p[2];

function klvPayloads(ts: Buffer): Buffer[] {
  const out: Buffer[] = [];
  let pes: Buffer[] = [];
  const flush = () => {
    const b = Buffer.concat(pes);
    if (b.length) out.push(b.subarray(9 + b[8], 6 + b.readUInt16BE(4)));
    pes = [];
  };
  for (let i = 0; i + 188 <= ts.length; i += 188) {
    const p = ts.subarray(i, i + 188);
    if (pidOf(p) !== 0x101) continue;
    if (p[1] & 0x40) flush();
    pes.push(p.subarray(p[3] & 0x20 ? 5 + p[4] : 4));
  }
  flush();
  return out;
}

/** Bytes of H.264 payload versus everything else (headers, PSI, stuffing). */
function tsOverhead(ts: Buffer) {
  let videoPayload = 0;
  let patPackets = 0;
  for (let i = 0; i + 188 <= ts.length; i += 188) {
    const p = ts.subarray(i, i + 188);
    const pid = pidOf(p);
    if (pid === 0) patPackets++;
    if (pid !== 0x100) continue;
    let offset = p[3] & 0x20 ? 5 + p[4] : 4;
    if (p[1] & 0x40) offset += 9 + p[offset + 8];
    videoPayload += 188 - offset;
  }
  return { videoPayload, patPackets };
}

async function udpReceiver() {
  const socket = createSocket('udp4');
  await new Promise<void>((r) => socket.bind(0, '127.0.0.1', r));
  const datagrams: Buffer[] = [];
  socket.on('message', (m) => datagrams.push(m));
  return { socket, port: socket.address().port, datagrams };
}

async function main() {
  // 1. UDP receivers: the initial output, and the one the stream is moved to at the end
  const { socket: udp, port: udpPort, datagrams } = await udpReceiver();
  const moved = await udpReceiver();

  // 2. Relay and demo dev server (which proxies /relay to the relay)
  const relay = await startRelay({
    port: RELAY_PORT,
    webTransportPort: WT_PORT,
    hostnames: ['localhost', '127.0.0.1'],
    allow: ['127.0.0.1:*'],
    log: (m) => console.log(`[relay] ${m}`),
  });
  // Route the device to our receiver through the API, as an operator would.
  const put = await fetch(`http://127.0.0.1:${RELAY_PORT}/streams/${DEVICE_ID}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ target: `udp://127.0.0.1:${udpPort}` }),
  });
  if (!put.ok) throw new Error(`PUT /streams failed: ${put.status} ${await put.text()}`);
  process.env.RELAY_PORT = String(RELAY_PORT);
  const vite = await createServer({
    configFile: resolve(import.meta.dirname, '../packages/demo/vite.config.ts'),
    root: resolve(import.meta.dirname, '../packages/demo'),
    server: { port: 0, host: '127.0.0.1' },
    logLevel: 'warn',
  });
  await vite.listen();
  const pageUrl = vite.resolvedUrls!.local[0];

  // 3. Browser with fake camera, geolocation and orientation
  const browser = await chromium.launch({
    executablePath: process.env.CHROME_PATH || undefined,
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
  });
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    permissions: ['geolocation', 'camera'],
    geolocation: { ...LOCATION, accuracy: 5 },
  });
  const page = await context.newPage();
  if (process.env.FALLBACK) {
    // Exercise the <video> + requestVideoFrameCallback frame source used by Safari and Firefox.
    await page.addInitScript(() => delete (window as { MediaStreamTrackProcessor?: unknown }).MediaStreamTrackProcessor);
  }
  page.on('console', (m) => console.log(`[page] ${m.text()}`));
  page.on('pageerror', (e) => console.log(`[page error] ${e.message}`));
  await page.goto(pageUrl);
  await page.fill('#device-id', DEVICE_ID);
  await page.click('details summary'); // Options
  await page.fill('#device-name', 'E2E browser');
  await page.selectOption('#transport', TRANSPORT);
  await page.selectOption('#wt-mode', WT_MODE);
  await page.fill('#wt-url', `https://127.0.0.1:${WT_BROKEN ? 9 : WT_PORT}/stream`);
  await page.evaluate((o) => {
    setInterval(
      () => window.dispatchEvent(new DeviceOrientationEvent('deviceorientationabsolute', { ...o, absolute: true })),
      100,
    );
  }, ORIENTATION);

  await page.click('#start');
  await page.waitForSelector('#state[data-state="streaming"]', { timeout: 15_000 }).catch(async (err) => {
    const log = await page.evaluate(() => [...document.querySelectorAll('#log li')].map((li) => li.textContent).reverse());
    console.error('Demo log:\n ', log.join('\n  '));
    throw err;
  });
  await page.waitForTimeout((STREAM_SECONDS * 1000) / 2);

  // Change frame rate and bitrate mid-stream, as a user dragging the sliders would.
  const setSlider = (id: string, value: number) =>
    page.$eval(
      `#${id}`,
      (el, v) => {
        (el as HTMLInputElement).value = String(v);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      },
      value,
    );
  await setSlider('fps', LIVE_FPS);
  await setSlider('bitrate', LIVE_BITRATE_KBPS);
  await page.waitForTimeout((STREAM_SECONDS * 1000) / 2);

  const panel = await page.evaluate(() =>
    Object.fromEntries(['m-pos', 'm-pose', 'm-center', 'm-fov', 's-fps', 's-bitrate', 's-transport', 's-codec', 's-frames'].map((id) => [id, document.getElementById(id)!.textContent])),
  );
  const log = await page.evaluate(() => [...document.querySelectorAll('#log li')].map((li) => li.textContent).reverse());
  const relayView = relay.registry.info(DEVICE_ID);

  // Move the live stream to the second receiver from the demo's streams panel.
  const row = page.locator(`li[data-device="${DEVICE_ID}"]`);
  await row.locator('.stream-status', { hasText: 'live' }).waitFor({ timeout: 5000 });
  await row.locator('input').fill(`udp://127.0.0.1:${moved.port}`);
  await row.locator('button[type="submit"]').click();
  await row.locator('.stream-message', { hasText: 'Output updated' }).waitFor({ timeout: 5000 });
  const datagramsBeforeMove = datagrams.length;
  await page.waitForTimeout(2500); // > keyframe interval, so the new receiver gets SPS/PPS + IDR
  const streamsPanel = await row.textContent();

  if (process.env.SCREENSHOT) await page.screenshot({ path: process.env.SCREENSHOT, fullPage: true });
  await page.click('#stop');
  await page.waitForTimeout(500);

  await browser.close();
  await vite.close();
  relay.close();
  udp.close();
  moved.socket.close();

  console.log('\nDemo panel:', panel);
  console.log('Demo log:\n ', log.join('\n  '));
  console.log('Relay view of the device:', relayView);
  console.log('Streams panel row:', streamsPanel);

  // 4. Check the captured stream
  const ts = Buffer.concat(datagrams);
  const dir = mkdtempSync(join(tmpdir(), 'e2e-'));
  const file = join(dir, 'capture.ts');
  writeFileSync(file, ts);
  console.log(`\nCaptured ${datagrams.length} datagrams, ${(ts.length / 1e6).toFixed(2)} MB -> ${file}`);

  const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file]).toString());
  for (const s of probe.streams) {
    console.log(`  stream ${s.index}: ${s.codec_type} ${s.codec_name ?? ''} ${s.width ? `${s.width}x${s.height}` : ''}`);
  }
  console.log(`  duration ${Number(probe.format.duration).toFixed(2)} s`);
  const overhead = tsOverhead(ts);
  const seconds = Number(probe.format.duration);
  console.log(
    `  video payload ${(100 * overhead.videoPayload / ts.length).toFixed(1)}% of TS bytes, ` +
      `PAT ${(overhead.patPackets / seconds).toFixed(1)}/s`,
  );
  const decodeErrors = execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-map', '0:v', '-f', 'null', '-'], { stdio: ['ignore', 'pipe', 'pipe'] }).toString();

  const klv = klvPayloads(ts).map((p) => {
    const values = misb.st0601.parse(p);
    return Object.fromEntries(values.map((v) => [v.name ?? v.key, v.key === 1 ? (v.valid === false ? 'INVALID' : 'ok') : v.value]));
  });
  console.log(`\n${klv.length} KLV packets; last one:`, klv.at(-1));

  const failures: string[] = [];
  const codecs = probe.streams.map((s: { codec_name?: string }) => s.codec_name);
  if (!codecs.includes('h264')) failures.push('no h264 stream');
  if (!codecs.includes('klv')) failures.push('no klv stream');
  if (decodeErrors) failures.push(`decode errors: ${decodeErrors}`);
  if (klv.length < STREAM_SECONDS - 1) failures.push(`expected ~${STREAM_SECONDS} KLV packets, got ${klv.length}`);
  const last = klv.at(-1) ?? {};
  if (Math.abs((last['Sensor Latitude'] as number) - LOCATION.latitude) > 1e-5) failures.push('latitude mismatch');
  if (Math.abs((last['Sensor Longitude'] as number) - LOCATION.longitude) > 1e-5) failures.push('longitude mismatch');
  if (Math.abs((last['Platform Heading Angle'] as number) - 45) > 0.5) failures.push('heading mismatch');
  if (Math.abs((last['Sensor Relative Elevation Angle'] as number) + 10) > 0.5) failures.push('elevation mismatch');
  if (klv.some((k) => k.Checksum === 'INVALID')) failures.push('invalid KLV checksum');
  // Default 1.5 m height, 10° down: frame centre 1.5/tan(10°) = 8.51 m away towards 45°.
  const ground = 1.5 / Math.tan((10 * Math.PI) / 180);
  const mPerDegLat = (6_371_008.8 * Math.PI) / 180;
  const expectLat = LOCATION.latitude + (ground * Math.SQRT1_2) / mPerDegLat;
  const expectLon = LOCATION.longitude + (ground * Math.SQRT1_2) / (mPerDegLat * Math.cos((LOCATION.latitude * Math.PI) / 180));
  if (Math.abs((last['Slant Range'] as number) - 1.5 / Math.sin((10 * Math.PI) / 180)) > 0.01) failures.push(`slant range ${last['Slant Range']}`);
  if (Math.abs((last['Frame Center Latitude'] as number) - expectLat) > 1e-6) failures.push('frame centre latitude mismatch');
  if (Math.abs((last['Frame Center Longitude'] as number) - expectLon) > 1e-6) failures.push('frame centre longitude mismatch');
  if (!('Corner Latitude Point 1' in last && 'Corner Longitude Point 4' in last)) failures.push('footprint corners missing');
  const expectedTransport = TRANSPORT === 'websocket' || WT_BROKEN ? 'websocket' : `webtransport/${WT_MODE}`;
  if (panel['s-transport'] !== expectedTransport) failures.push(`transport ${panel['s-transport']}, expected ${expectedTransport}`);
  if (WT_BROKEN && !log.some((l) => l?.includes('falling back to WebSocket'))) failures.push('no fallback warning logged');
  const [actualFps, limitFps] = (panel['s-fps'] ?? '').match(/\d+/g)?.map(Number) ?? [];
  if (limitFps !== LIVE_FPS || Math.abs(actualFps - LIVE_FPS) > 2) failures.push(`frame rate not applied live: ${panel['s-fps']}`);
  if (!panel['s-bitrate']?.includes(`/ ${LIVE_BITRATE_KBPS} kbps`)) failures.push(`bitrate not applied live: ${panel['s-bitrate']}`);
  if (relayView?.name !== 'E2E browser' || relayView.peer !== '127.0.0.1' || relayView.transport !== expectedTransport) {
    failures.push(`relay stream info wrong: ${JSON.stringify(relayView)}`);
  }

  // The moved stream: the first receiver stops, the second gets a decodable stream with KLV.
  if (datagrams.length > datagramsBeforeMove + 2) failures.push(`first receiver kept receiving after the move (${datagrams.length - datagramsBeforeMove} datagrams)`);
  const movedFile = join(dir, 'moved.ts');
  writeFileSync(movedFile, Buffer.concat(moved.datagrams));
  const movedProbe = JSON.parse(
    execFileSync('ffprobe', ['-v', 'error', '-count_frames', '-show_streams', '-of', 'json', movedFile], {
      // It starts mid-GOP, so ffprobe complains about frames before the first keyframe.
      stdio: ['ignore', 'pipe', 'ignore'],
    }).toString(),
  );
  const movedVideo = movedProbe.streams.find((s: { codec_name?: string }) => s.codec_name === 'h264');
  console.log(`\nMoved stream: ${moved.datagrams.length} datagrams, ${movedVideo?.nb_read_frames ?? 0} decodable frames -> ${movedFile}`);
  if (!movedVideo || !(Number(movedVideo.nb_read_frames) > 0)) failures.push('second receiver got no decodable video after the move');
  if (!movedProbe.streams.some((s: { codec_name?: string }) => s.codec_name === 'klv')) failures.push('second receiver got no KLV stream');

  if (failures.length) {
    console.error('\nFAILED:\n  ' + failures.join('\n  '));
    process.exit(1);
  }
  console.log('\nE2E OK');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
