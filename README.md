# web-video-streamer

Stream a phone (or any browser) camera to a remote server as **MPEG-TS over UDP** with **MISB ST 0601 KLV** metadata: location, camera pointing direction, and horizontal/vertical field of view, inserted once per second.

```
 Browser (library)                       Relay (Node)                 Receiver
┌───────────────────────────────┐       ┌─────────────────────┐      ┌──────────────┐
│ camera ─► WebCodecs H.264 ─┐  │  WT   │ WebTransport :4433  ├─┐    │ ffplay / VLC │
│                            ├► TS ───►│   (UDP / QUIC)      │ │UDP │ QGIS FMV     │
│ GPS, compass, photo EXIF   │  │  or   │ WebSocket :8090     ├─┴───►│ STANAG 4609  │
│  ─► ST 0601 KLV ───────────┘  ├──────►│   (TCP)             │      │ tools        │
└───────────────────────────────┘  WS   │ target allowlist    │      └──────────────┘
                                        └─────────────────────┘
```

Browsers cannot open UDP sockets, so the library builds the complete transport stream in the page and sends it to a small relay, which forwards the bytes unchanged as UDP datagrams. The page reaches the relay over **WebTransport** (HTTP/3 over QUIC; preferred) or, as a fallback, over a **WebSocket**.

## Packages

| Package | Description |
|---|---|
| `packages/lib` (`@web-video-streamer/lib`) | The browser library: camera, WebCodecs encoder, MPEG-TS muxer, ST 0601 encoder, sensors, FOV and ground footprint, WebTransport/WebSocket transports |
| `packages/relay` (`@web-video-streamer/relay`) | WebTransport + WebSocket → UDP relay with a destination allowlist |
| `packages/demo` | Test web app (Vite, HTTPS) |
| `scripts/e2e.ts` | End-to-end test: headless Chromium → relay → UDP capture, checked with ffprobe and a KLV parser |

## Quick start

Requires Node 22+. The relay's WebTransport server (`@fails-components/webtransport`) uses a native libquiche addon. Prebuilt binaries exist for Linux, macOS and Windows on x64 (and arm on Linux and macOS); other platforms compile it on install (needs CMake and a C++ toolchain).

```sh
npm install
npm test                          # unit tests (KLV, TS muxer + ffprobe, FOV, orientation, footprint, relay incl. WebTransport)
npm run typecheck

# terminal 1: relay; ALLOW lists the UDP destinations it may send to
ALLOW=192.168.1.50:* npm run relay

# terminal 2: demo app over HTTPS (self-signed cert) on all interfaces, port 5173
npm run dev

# on the receiving machine (192.168.1.50 in this example)
ffplay -fflags nobuffer udp://0.0.0.0:5000
```

On the phone:
1. Open `https://<your-computer's-LAN-IP>:5173` and accept the certificate warning.
2. Set **UDP target** to `udp://192.168.1.50:5000`.
3. Optionally tap **Calibrate FOV** to take a photo with the camera app.
4. Tap **Start streaming**.

Firewall: the phone must reach TCP 5173 (the page; the WebSocket and `/relay/cert-hash` go through the dev server's proxy) and UDP 4433 (WebTransport, direct to the relay). If UDP 4433 is blocked, the default **Auto** transport falls back to WebSocket and logs a warning.

The demo page has:
* **Connection:** relay URL, UDP target, transport (Auto / WebTransport only / WebSocket only), WebTransport mode (datagrams / reliable stream) and WebTransport URL (default `https://<page host>:4433/stream`). The relay certificate hash is fetched at page load.
* **Live controls:** frame-rate and bitrate sliders, plus camera height above ground and max range for the footprint. All apply while streaming.
* **Map (OpenStreetMap):** camera position, GPS accuracy circle, and the ground footprint, with a dot where the optical axis meets the ground. The outline is dashed when part of the view is cut off at the max range. It follows the camera until you pan; ◎ re-centres it.
* **Panels:** position, altitude, azimuth/elevation/roll, frame centre distance and slant range, FOV and its source, camera, frame rate and bitrate (actual / target), transport, H.264 profile, frames encoded/dropped, bytes sent, and a log of events and warnings.

Settings are remembered in the browser.

### End-to-end test

`npm run e2e` runs the whole chain: headless Chromium with a fake camera, the demo page, the relay, and a local UDP socket. It changes frame rate and bitrate mid-stream, then checks the capture:
* ffprobe finds H.264 + KLV, and the video decodes with no errors;
* the KLV packets parse with valid checksums, and the position, heading, elevation, footprint and transport are correct;
* the live changes took effect.

| Variable | |
|---|---|
| `CHROME_PATH` | Browser executable, if Playwright's bundled Chromium isn't installed |
| `TRANSPORT` | `auto` (default), `webtransport` or `websocket` |
| `WT_MODE` | `datagram` (default) or `stream` |
| `WT_BROKEN=1` | Unreachable WebTransport URL: checks the fallback to WebSocket |
| `FALLBACK=1` | Hides MediaStreamTrackProcessor to test the Safari/Firefox frame path |
| `STREAM_SECONDS` | Streaming time (default 6) |
| `SCREENSHOT` | Save a screenshot of the page to this path |

## Library usage

```ts
import { createStreamer, capturePhotoWithNativeCamera } from '@web-video-streamer/lib';

// Optional, from a click handler: a native camera photo keeps lens EXIF data.
const calibrationPhoto = await capturePhotoWithNativeCamera();

const streamer = createStreamer({
  webTransportUrl: 'https://relay.example.com:4433/stream', // preferred when the browser supports it
  relayUrl: 'wss://relay.example.com:8090',                // WebSocket fallback
  // serverCertificateHash: '<base64>',                    // only for a self-signed relay certificate (GET /cert-hash)
  target: 'udp://10.0.0.5:5000',
  videoElement: document.querySelector('video')!, // optional preview
  calibrationPhoto: calibrationPhoto ?? undefined,
});

streamer.on('state', (s) => console.log(s));       // initializing | streaming | reconnecting | stopped | error
streamer.on('metadata', (m) => console.log(m));    // position, pose, fov, footprint, once per KLV packet
streamer.on('fov', (f) => console.log(f));         // FOV and its source, when estimated or the frame size changes
streamer.on('stats', (s) => console.log(s));       // fps, bitrate (actual/target), transport, codec, frames dropped, bytes sent
streamer.on('warning', console.warn);
streamer.on('error', console.error);

button.onclick = () => streamer.start();          // call from a user gesture (iOS sensor permission)

// Adjustable while streaming (or before start):
streamer.setFrameRate(15);                         // max fps; extra camera frames are skipped
streamer.setBitrate(1_500_000);                    // bits/s; undefined = automatic. Forces a keyframe.
streamer.setFootprintOptions({ heightAboveGround: 3, maxRange: 500 });
streamer.snapshot();                               // latest position, pose, FOV and footprint (for maps/overlays)
streamer.transportKind;                            // e.g. "webtransport/datagram" or "websocket"
await streamer.stop();
```

Also exported: `isEncodingSupported()`, `isWebTransportSupported()`, `computeFootprint()`, `encodeSt0601()`, `TsMuxer`, `readPhotoInfo()`, `photoFov()`, `videoFov()`, `cameraPose()`, `rotationMatrix()`.

Options (`StreamerOptions`):

| Option | Default | |
|---|---|---|
| `relayUrl` | — | WebSocket URL: `ws://`, `wss://`, or relative. Required unless `transport: 'webtransport'` |
| `transport` | `'auto'` | `'auto'`: WebTransport if supported and `webTransportUrl` is set, otherwise or on failure WebSocket. `'webtransport'` / `'websocket'` force one |
| `webTransportUrl` | — | e.g. `https://relay.example.com:4433/stream` |
| `webTransportMode` | `'datagram'` | `'datagram'` (unreliable, lowest latency) or `'stream'` (reliable, ordered) |
| `serverCertificateHash` | — | Base64 SHA-256 of a self-signed relay certificate (from the relay's `GET /cert-hash`) |
| `target` | relay's `DEFAULT_TARGET` | UDP destination (`udp://host:port`), sent to the relay when connecting. Use a different one per stream |
| `width`, `height` | 1280, 720 | Requested capture size (ideal, not exact) |
| `fps` | 30 | Camera rate request and encoded frame-rate limit (`setFrameRate()` to change live) |
| `bitrate` | ~0.1 bit/pixel·frame | H.264 bitrate, bits/s (`setBitrate()` to change live) |
| `keyframeIntervalMs` | 1000 | IDR interval |
| `maxQueueMs` | 500 | Latency bound: frames are skipped while more than this much video is waiting to be sent |
| `klvIntervalMs` | 1000 | KLV insertion interval |
| `fovOverride` | — | `{ horizontal, vertical }` degrees; skips estimation |
| `calibrationPhoto` | — | Blob/File from the native camera for FOV EXIF |
| `declination` | 0 | Degrees added to magnetic compass headings to get true north |
| `footprint` | `{ heightAboveGround: 1.5, maxRange: 2000 }` | Ground footprint settings (metres), or `false` to omit the footprint tags |
| `missionId`, `platformDesignation` | —, `Mobile Browser` | ST 0601 tags 3 and 10 |
| `facingMode` / `deviceId` | `environment` | Camera selection |

## Stream format

* **PIDs:** PAT 0x0000, PMT 0x1000, video 0x0100 (stream_type 0x1B, H.264 Annex-B with AUDs, SPS/PPS before every IDR, also the PCR PID), KLV 0x0101.
* **KLV carriage:** asynchronous metadata per MISB ST 1402: stream_type 0x06, PES stream_id 0xBD, registration descriptor `KLVA`, with PTS on the same clock as video.
* H.264 profile: High, then Main, then Constrained Baseline, whichever the device's encoder accepts first. Encoding is in realtime mode with no B-frames; if an encoder reorders frames anyway, the library switches to Constrained Baseline.
* PAT/PMT are sent with every keyframe and at least every 500 ms (the ETSI TR 101 290 limit). Keyframes come every second, and on every relay (re)connection, so receivers can join at any time.

### ST 0601 tags

| Tag | Name | Source |
|---|---|---|
| 2 | Precision Time Stamp | Wall clock (µs) |
| 3 | Mission ID | `missionId` option |
| 5 | Platform Heading | Camera azimuth (degrees clockwise from north) |
| 6, 7 | Platform Pitch / Roll | 0 (the phone is both platform and sensor) |
| 10 | Platform Designation | `platformDesignation` option |
| 11 | Image Source Sensor | EXIF Make/Model, or the camera's label |
| 13, 14 | Sensor Latitude / Longitude | Geolocation API |
| 75 | Sensor Ellipsoid Height | Geolocation altitude (WGS84 ellipsoid), when available |
| 16, 17 | Sensor HFOV / VFOV | Photo EXIF, adjusted for the video crop and zoom |
| 18, 19, 20 | Sensor Relative Azimuth / Elevation / Roll | 0 / camera elevation / image roll |
| 21 | Slant Range | Camera to frame centre (m) |
| 23, 24 | Frame Center Latitude / Longitude | Where the optical axis meets the ground |
| 82–89 | Corner Latitude / Longitude Points 1–4 (full) | Ground position of the image corners (upper-left, upper-right, lower-right, lower-left) |
| 65 | UAS LS Version | 17 |
| 1 | Checksum | 16-bit running sum |

Tags with no data (no GPS fix, no orientation sensor) are left out instead of being sent as zeros.

## How the values are derived

**Field of view.** Lens data comes from the first photo that has `FocalLengthIn35mmFilm` in its EXIF data:
1. `fovOverride`, if given.
2. `calibrationPhoto`, a photo from the native camera app (`<input type=file capture=environment>`). This is the most reliable source, because native photos keep their lens EXIF data.
3. `ImageCapture.takePhoto()` on the live track (Chromium only; these photos often have no lens EXIF).
4. Otherwise a 26 mm equivalent, a typical phone main camera (a `warning` event is emitted).

The 35 mm equivalent is defined on the diagonal. The diagonal is split by the photo's aspect ratio to get the photo's horizontal and vertical FOV. The video frame is then treated as the largest centred crop of the photo frame with the video's aspect ratio: a 16:9 video from a 4:3 sensor keeps the horizontal FOV and loses some vertical FOV. The result is then divided by the track's digital zoom. Axes swap when the video is in portrait.

**Pointing direction.** Device orientation angles (Z-X′-Y″ Euler, W3C) give a device-to-world rotation. The rear camera's optical axis (device −Z) gives azimuth and elevation. Roll is measured from level using the screen orientation, because video frames follow the screen. Sources:
* **Android / Chromium:** `deviceorientationabsolute`.
* **iOS:** `webkitCompassHeading`. Permission is requested in `start()`, which must run from a tap.
* **Desktop:** no sensors, so pointing tags are omitted.

Headings are magnetic. Set `declination` for true north.

**Ground footprint.** Rays through the image centre, corners and edges are projected onto flat ground `heightAboveGround` below the camera (default 1.5 m, a hand-held phone). GPS altitude is too inaccurate (±10–30 m) to use for this. Rays at or above the horizon, or hitting the ground beyond `maxRange` (default 2 km), are cut off at that horizontal distance. Each point is flagged `capped`, and the frame centre and slant range are then distances to that cut-off, not to the ground. The footprint is computed only when there is a position and a north-referenced heading. `snapshot().footprint` also gives a sampled outline for drawing; the demo map shows it, with a dashed border when part of the view is cut off. Terrain (hills, buildings) is not modelled.

## Browser support

| | Chrome / Edge (Android, desktop) | Safari (iOS 16.4+, macOS) | Firefox 130+ |
|---|---|---|---|
| H.264 via WebCodecs | ✅ | ✅ | ✅ (desktop; Android varies) |
| Frame source | MediaStreamTrackProcessor | `<video>` + requestVideoFrameCallback | `<video>` + requestVideoFrameCallback |
| Absolute orientation | ✅ | ✅ (compass, permission prompt) | ⚠️ relative only on some devices |
| ImageCapture EXIF | ⚠️ often missing | ❌ (use calibration photo) | ❌ |
| WebTransport | ✅ | Safari 26.4+ (else WebSocket) | ✅ |

An HTTPS page (secure context) is required for the camera, location and motion sensors.

## Transports

| | WebTransport, datagrams (default) | WebTransport, reliable stream | WebSocket (fallback) |
|---|---|---|---|
| Underlying | QUIC datagrams (UDP) | One QUIC stream | TCP |
| On packet loss | Lost packets are gone: picture glitches until the next keyframe (≤ 1 s) | Retransmitted; delay can grow | Retransmitted; everything behind a loss waits |
| Latency | Lowest; the browser discards datagrams older than 500 ms instead of sending them late | Low | Grows on bad links |
| Relay → UDP | Each datagram forwarded as one UDP datagram (6 TS packets, ≤ 1200 B) | Re-chunked into ≤ 1316 B datagrams | Re-chunked into ≤ 1316 B datagrams |

With `transport: 'auto'`, a WebTransport connection failure (unsupported browser, blocked UDP, bad certificate; 3 s timeout) falls back to WebSocket and emits a `warning`. Stats and `streamer.transportKind` report the transport in use. After a successful connection, drops reconnect with the same transport.

WebTransport session protocol: the page opens a bidirectional control stream and writes one JSON line, `{"target": "udp://host:port", "mode": "datagram" | "stream"}`. The relay answers `{"ok": true}` or `{"error": "..."}`, then video follows as datagrams or on one unidirectional stream.

## Relay

```sh
PORT=8090 ALLOW="10.0.0.5:5000,127.0.0.1:*" DEFAULT_TARGET=udp://10.0.0.5:5000 npm run relay
# Use a real certificate for wss:// and WebTransport:
TLS_CERT=cert.pem TLS_KEY=key.pem npm run relay
```

| Variable | Default | |
|---|---|---|
| `PORT` | 8090 | WebSocket and HTTP (`GET /cert-hash`) port, TCP |
| `WT_PORT` | 4433 | WebTransport port, **UDP** (`off` disables) |
| `ALLOW` | `127.0.0.1:*` | Allowed UDP destinations |
| `DEFAULT_TARGET` | — | Target used when a client sends none |
| `TLS_CERT` / `TLS_KEY` | — | PEM certificate and key |
| `WT_HOSTNAMES` | localhost + this host's IPs | Names in the generated certificate |

The relay refuses any destination not on `ALLOW` (WebSocket close code 1008, or an `{"error"}` reply over WebTransport), so it can't be used to send UDP to arbitrary hosts.

**Certificates.** WebTransport always needs TLS. Without `TLS_CERT`/`TLS_KEY`, the relay generates an ECDSA certificate valid for 13 days at startup. Browsers accept it when the page passes its hash as `serverCertificateHash`; `GET /cert-hash` returns `{"sha256": "..."}`. These certificates may last at most 14 days, so **restart the relay at least every 13 days** (the startup log shows the expiry). For production, use a real certificate.

**Multiple streams.** One relay serves any number of streams at once. Each WebSocket connection or WebTransport session gets its own UDP socket and target, and the relay only forwards bytes, so its load is mainly bandwidth (the sum of the streams). Every stream uses the same PIDs (0x100/0x101), so **give each stream its own target** (port or host): two streams sent to one target interleave into something receivers can't separate. The relay doesn't reserve targets, so it won't stop two clients from choosing the same one.

**Networking.** WebTransport is HTTP/3, so it can't go through the dev server's proxy or most HTTP reverse proxies. Clients connect straight to UDP `WT_PORT`, which must be open in any firewall. On WSL2 that means both the Windows firewall and the Hyper-V (WSL) firewall.

## Verifying a stream

```sh
ffprobe udp://0.0.0.0:5000                       # shows h264 + "Data: klv (KLVA / 0x41564C4B)"
```

To inspect KLV values, use a STANAG 4609 tool such as QGIS FMV, the Python `klvdata` package, or `@vidterra/misb.js`.

FFmpeg 6.1.x has a bug: when extracting KLV it strips 5 bytes from **asynchronous** KLV packets (it wrongly assumes a sync-metadata AU header). That corrupts the packets FFmpeg extracts (`-map 0:d -f data`). The stream itself is correct; use FFmpeg 7+ or another demuxer. The e2e script demuxes the KLV PID itself for this reason.

## Known limitations

* Video only (no audio).
* One stream per phone in practice: phones usually let only one page use a camera at a time.
* Over a WebSocket (TCP), network stalls cause latency rather than loss; frames are skipped before encoding while more than `maxQueueMs` (default 500 ms) of video at the configured bitrate is waiting to be sent, so latency stays bounded.
* Compass accuracy on phones is typically ±5–15° and is sensitive to nearby metal and magnets.
* FOV assumes the video is an uncropped region of the photo sensor. Electronic stabilisation or a different lens in video mode can make the real FOV narrower; use `fovOverride` if you know the true value.
* Geolocation altitude is often missing on desktop browsers and some iOS versions; tag 75 is omitted then.
