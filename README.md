# web-video-streamer

Stream a phone (or any browser) camera to a remote server as **MPEG-TS over UDP** with **MISB ST 0601 KLV** metadata: location, camera pointing direction, and horizontal/vertical field of view, inserted once per second.

```
 Browser (library)                       Relay (Node)                 Receiver
┌───────────────────────────────┐       ┌─────────────────────┐      ┌──────────────┐
│ camera ─► WebCodecs H.264 ─┐  │  WT   │ WebTransport :4433  ├─┐    │ ffplay / VLC │
│                            ├► TS ───►│   (UDP / QUIC)      │ │UDP │ QGIS FMV     │
│ GPS, compass, photo EXIF   │  │  or   │ WebSocket :8090     ├─┴───►│ STANAG 4609  │
│  ─► ST 0601 KLV ───────────┘  ├──────►│   (TCP)             │      │ tools        │
└───────────────────────────────┘  WS   │ device → UDP map    │      └──────────────┘
                                        └─────────────────────┘
```

Browsers cannot open UDP sockets, so the library builds the complete transport stream in the page and sends it to a small relay, which forwards the bytes unchanged as UDP datagrams. The page reaches the relay over **WebTransport** (HTTP/3 over QUIC; preferred) or, as a fallback, over a **WebSocket**.

The library doesn't know where the video ends up. It identifies itself with a **device ID**, and the relay decides which UDP output each device goes to: it auto-assigns a port the first time it sees a device, remembers the mapping, and lets an operator change it (including mid-stream) through its `/streams` API or the demo page. See [Routing](#routing-device--udp-output).

> **0.2.0 breaking changes:** the `target` option is gone (routing belongs to the relay), the relay's `DEFAULT_TARGET` is replaced by auto-assignment, and the camera-selection option `deviceId` is now `cameraId` (`deviceId` now means the relay identity).

## Install

```sh
npm install web-video-streamer          # browser library
npx web-video-streamer-relay            # relay (or: npm install web-video-streamer-relay)
```

The library ships ES module and UMD builds with TypeScript declarations. The relay is a Node 22+ command, `web-video-streamer-relay`, configured by environment variables (see [Relay](#relay)). It also exports a programmatic API: `startRelay()`, `StreamRegistry`, `createRelay()`, `createWebTransportRelay()` and `generateSelfSignedCertificate()`.

## Packages

| Package | Description |
|---|---|
| `packages/lib` (`web-video-streamer`) | The browser library: camera, WebCodecs encoder, MPEG-TS muxer, ST 0601 encoder, sensors, FOV and ground footprint, WebTransport/WebSocket transports |
| `packages/relay` (`web-video-streamer-relay`) | WebTransport + WebSocket → UDP relay: device → output mapping, `/streams` API, destination allowlist |
| `packages/demo` | Test web app (Vite, HTTPS); not published |
| `scripts/e2e.ts` | End-to-end test: headless Chromium → relay → UDP capture, checked with ffprobe and a KLV parser |

## Development

Requires Node 22+ (`.nvmrc`). The relay's WebTransport server (`@fails-components/webtransport`) uses a native libquiche addon. Prebuilt binaries exist for Linux, macOS and Windows on x64 (and arm on Linux and macOS); other platforms compile it on install (needs CMake and a C++ toolchain).

```sh
npm install
npm test                          # unit tests (KLV, TS muxer + ffprobe, FOV, orientation, footprint, relay incl. WebTransport)
npm run verify                    # typecheck + unit tests + library and relay builds (what CI runs)

# terminal 1: relay; ALLOW lists the UDP destinations it may send to,
# AUTO_HOST is where new devices are sent (ports 5000-5099 by default)
ALLOW=192.168.1.50:* AUTO_HOST=192.168.1.50 npm run relay

# terminal 2: demo app over HTTPS (self-signed cert) on all interfaces, port 5173
npm run dev

# on the receiving machine (192.168.1.50 in this example)
ffplay -fflags nobuffer udp://0.0.0.0:5000
```

On the phone:
1. Open `https://<your-computer's-LAN-IP>:5173` and accept the certificate warning.
2. Optionally change the **Device ID** to something readable (e.g. `phone-chris`).
3. Optionally tap **Calibrate FOV** to take a photo with the camera app.
4. Tap **Start streaming**. The first device gets `udp://192.168.1.50:5000`; change it under **Relay streams** if you like.

Firewall: the phone must reach TCP 5173 (the page; the WebSocket, `/relay/cert-hash` and `/relay/streams` go through the dev server's proxy) and UDP 4433 (WebTransport, direct to the relay). If UDP 4433 is blocked, the default **Auto** transport falls back to WebSocket and logs a warning.

The demo page has:
* **Connection:** relay URL, device ID, transport (Auto / WebTransport only / WebSocket only), WebTransport mode (datagrams / reliable stream) and WebTransport URL (default `https://<page host>:4433/stream`). The relay certificate hash is fetched at page load.
* **Live controls:** frame-rate and bitrate sliders, plus camera height above ground and max range for the footprint. All apply while streaming.
* **Map (OpenStreetMap):** camera position, GPS accuracy circle, and the ground footprint, with a dot where the optical axis meets the ground. The outline is dashed when part of the view is cut off at the max range. It follows the camera until you pan; ◎ re-centres it.
* **Relay streams:** every device the relay knows, live ones first, with source IP, transport, bitrate, and an editable UDP output (**Save** moves a live stream immediately). Offline devices can be forgotten, which frees their port. Polled every 2 s. If the relay has `ADMIN_TOKEN`, enter it under Options.
* **Options:** capture size, declination, mission ID, device name (shown in the relay list), relay admin token.
* **Panels:** position, altitude, azimuth/elevation/roll, frame centre distance and slant range, FOV and its source, camera, frame rate and bitrate (actual / target), transport, H.264 profile, frames encoded/dropped, bytes sent, and a log of events and warnings.

While streaming, the page holds a screen wake lock so the phone doesn't sleep (it is re-acquired when the page becomes visible again; a warning is logged where the Wake Lock API isn't supported). Settings are remembered in the browser.

### End-to-end test

`npm run e2e` runs the whole chain: headless Chromium with a fake camera, the demo page, the relay, and local UDP sockets. It routes the device to the first socket through `PUT /streams`, changes frame rate and bitrate mid-stream, then moves the stream to a second socket from the demo's **Relay streams** panel. It checks:
* ffprobe finds H.264 + KLV in the first capture, and the video decodes with no errors;
* the KLV packets parse with valid checksums, and the position, heading, elevation, footprint and transport are correct;
* the live changes took effect, and the relay reports the device's name, source IP and transport;
* after the move, the first socket stops receiving and the second gets decodable video and KLV.

| Variable | |
|---|---|
| `CHROME_PATH` | Browser executable, if Playwright's bundled Chromium isn't installed |
| `TRANSPORT` | `auto` (default), `webtransport` or `websocket` |
| `WT_MODE` | `datagram` (default) or `stream` |
| `WT_BROKEN=1` | Unreachable WebTransport URL: checks the fallback to WebSocket |
| `FALLBACK=1` | Hides MediaStreamTrackProcessor to test the Safari/Firefox frame path |
| `STREAM_SECONDS` | Streaming time (default 6) |
| `SCREENSHOT` | Save a screenshot of the page to this path |

### CI and releases

* **CI** (`.github/workflows/ci.yml`) runs on every push to `main` and on pull requests:
  * `npm run verify`, with ffmpeg installed so the muxer test checks real output;
  * the browser e2e test in five variants: WebTransport datagrams, WebTransport stream, WebSocket, fallback from a broken WebTransport URL to WebSocket, and the `<video>` frame path.
  * A failing e2e variant uploads its screenshot.
* **Release** (`.github/workflows/publish.yml`) is started by hand: Actions → Release → Run workflow, with a version like `0.2.0`. It then:
  1. sets both packages' versions;
  2. runs `verify` and every e2e variant;
  3. commits, tags `vX.Y.Z` and pushes to `main`;
  4. publishes `web-video-streamer` and `web-video-streamer-relay` to npm, with provenance, through npm Trusted Publishing (no token stored in the repo).

  Each package needs a trusted publisher on npmjs.com pointing at this repository and `publish.yml`.

## Library usage

```ts
import { createStreamer, capturePhotoWithNativeCamera } from 'web-video-streamer';

// Optional, from a click handler: a native camera photo keeps lens EXIF data.
const calibrationPhoto = await capturePhotoWithNativeCamera();

const streamer = createStreamer({
  webTransportUrl: 'https://relay.example.com:4433/stream', // preferred when the browser supports it
  relayUrl: 'wss://relay.example.com:8090',                // WebSocket fallback
  // serverCertificateHash: '<base64>',                    // only for a self-signed relay certificate (GET /cert-hash)
  deviceId: 'phone-chris',                                // optional; default is a random ID kept in localStorage
  deviceName: 'Chris’s phone',                           // optional label for the relay's list
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
streamer.deviceId;                                 // the ID the relay routes by
await streamer.stop();
```

Also exported: `getDeviceId()` (this browser's stored ID, to show before streaming), `isEncodingSupported()`, `isWebTransportSupported()`, `computeFootprint()`, `encodeSt0601()`, `TsMuxer`, `readPhotoInfo()`, `photoFov()`, `videoFov()`, `cameraPose()`, `rotationMatrix()`.

Options (`StreamerOptions`):

| Option | Default | |
|---|---|---|
| `relayUrl` | — | WebSocket URL: `ws://`, `wss://`, or relative. Required unless `transport: 'webtransport'` |
| `transport` | `'auto'` | `'auto'`: WebTransport if supported and `webTransportUrl` is set, otherwise or on failure WebSocket. `'webtransport'` / `'websocket'` force one |
| `webTransportUrl` | — | e.g. `https://relay.example.com:4433/stream` |
| `webTransportMode` | `'datagram'` | `'datagram'` (unreliable, lowest latency) or `'stream'` (reliable, ordered) |
| `serverCertificateHash` | — | Base64 SHA-256 of a self-signed relay certificate (from the relay's `GET /cert-hash`) |
| `deviceId` | random, kept in localStorage | Identity the relay maps to a UDP output (1–64 of `A-Z a-z 0-9 . _ : -`). Browsers expose no hardware ID or local IP, so the default is generated once per browser profile (per page load if storage is blocked, with a warning) |
| `deviceName` | — | Label shown in the relay's stream list |
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
| `facingMode` / `cameraId` | `environment` | Camera selection; `cameraId` is a `MediaDeviceInfo.deviceId` |

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

Connecting: the WebSocket URL carries `?device=<id>&name=<label>`. Over WebTransport, the page opens a bidirectional control stream and writes one JSON line, `{"device": "<id>", "name": "<label>", "mode": "datagram" | "stream"}`; the relay answers `{"ok": true}` or `{"error": "..."}`, then video follows as datagrams or on one unidirectional stream. The client never names a UDP destination.

## Relay

```sh
PORT=8090 ALLOW="10.0.0.5:*" AUTO_HOST=10.0.0.5 AUTO_PORTS=5000-5099 ADMIN_TOKEN=change-me npx web-video-streamer-relay
# Use a real certificate for wss:// and WebTransport:
TLS_CERT=cert.pem TLS_KEY=key.pem npx web-video-streamer-relay
# In this repo, `npm run relay` runs the TypeScript source directly.
```

| Variable | Default | |
|---|---|---|
| `PORT` | 8090 | WebSocket and HTTP (`/cert-hash`, `/streams`) port, TCP |
| `WT_PORT` | 4433 | WebTransport port, **UDP** (`off` disables) |
| `ALLOW` | `*` | Allowed UDP destinations (`host:port`, `host:*`, `*` = any address). Set `ADMIN_TOKEN` if others can reach the `/streams` API |
| `AUTO_HOST` | `127.0.0.1` | Host of outputs auto-assigned to new devices |
| `AUTO_PORTS` | `5000-5099` | Port range for auto-assigned outputs |
| `MAPPINGS_FILE` | `./relay-mappings.json` | Where device → output mappings are kept across restarts (`off` = memory only) |
| `ADMIN_TOKEN` | — | If set, the `/streams` API requires `Authorization: Bearer <token>` |
| `TLS_CERT` / `TLS_KEY` | — | PEM certificate and key |
| `WT_HOSTNAMES` | localhost + this host's IPs | Names in the generated certificate |

The relay never sends to a destination not on `ALLOW`, whether auto-assigned or set through the API. The default, `*`, allows any address, so anyone who can reach the `/streams` API can point streams at any host; on a shared network, narrow `ALLOW` (e.g. `10.0.0.5:*`) or set `ADMIN_TOKEN`. It warns at startup if the auto-assign pool isn't covered by `ALLOW`.

### Routing (device → UDP output)

* A connection without a valid device ID is refused (WebSocket close code 1008, or an `{"error"}` reply over WebTransport).
* A device the relay hasn't seen gets the lowest free port in `AUTO_PORTS` on `AUTO_HOST`; it keeps that output on every later connection, including after a relay restart (`MAPPINGS_FILE`). Forgetting a device frees its port.
* Changing a device's output while it streams takes effect from the next datagram. Receivers on the new output pick up the stream at the next PAT/PMT (≤ 500 ms) and keyframe (≤ 1 s by default).
* If the same device ID connects again while a connection is live (a second tab, or a reconnect the relay hasn't noticed yet), the new connection wins and the old one is closed with code **4001**. The library treats 4001 as final and doesn't reconnect, so two tabs can't take turns knocking each other off.
* The relay records each stream's source IP for display. Behind a local reverse proxy (such as the demo's Vite server, which sets `X-Forwarded-For`), the header is trusted only when the connection comes from loopback.

HTTP API (on `PORT`, CORS enabled; with `ADMIN_TOKEN` every call needs `Authorization: Bearer <token>`, otherwise 401):

| Request | Response |
|---|---|
| `GET /streams` | `{"streams": [...], "allow": [...]}`; each stream has `deviceId`, `name`, `target`, `assigned` (`auto`/`manual`), `connected`, `transport`, `peer` (source IP), `connectedAt`, `lastSeen`, `bitrate` (bits/s), `bytes` |
| `GET /streams/<id>` | One stream, or 404 |
| `PUT /streams/<id>` with `{"target": "udp://host:port"}` | The updated stream; 400 bad target, 403 not on `ALLOW`. Works for devices not seen yet (pre-assigning) |
| `DELETE /streams/<id>` | 204; 404 unknown, 409 while streaming |

```sh
curl -s localhost:8090/streams
curl -s -X PUT localhost:8090/streams/phone-chris -H 'content-type: application/json' -d '{"target":"udp://10.0.0.5:5002"}'
```

**Certificates.** WebTransport always needs TLS. Without `TLS_CERT`/`TLS_KEY`, the relay generates an ECDSA certificate valid for 13 days at startup. Browsers accept it when the page passes its hash as `serverCertificateHash`; `GET /cert-hash` returns `{"sha256": "..."}`. These certificates may last at most 14 days, so **restart the relay at least every 13 days** (the startup log shows the expiry). For production, use a real certificate.

**Multiple streams.** One relay serves any number of devices at once. Each gets its own UDP socket and output, and the relay only forwards bytes, so its load is mainly bandwidth (the sum of the streams). Auto-assigned outputs are always distinct. Every stream uses the same PIDs (0x100/0x101), so if you set outputs by hand, **keep them distinct**: two streams sent to one output interleave into something receivers can't separate. The relay doesn't stop you from mapping two devices to the same output.

**Networking.** WebTransport is HTTP/3, so it can't go through the dev server's proxy or most HTTP reverse proxies. Clients connect straight to UDP `WT_PORT`, which must be open in any firewall. On WSL2 that means both the Windows firewall and the Hyper-V (WSL) firewall. Avoid `localhost` in the WebTransport URL: browsers try `::1` first and QUIC doesn't fall back to IPv4 the way TCP does, and WSL2's mirrored networking doesn't forward `::1` from Windows, so the connection times out. Use `127.0.0.1` (the demo does this automatically).

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
