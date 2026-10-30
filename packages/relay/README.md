# web-video-streamer-relay

WebTransport (HTTP/3) and WebSocket → UDP relay for [`web-video-streamer`](https://www.npmjs.com/package/web-video-streamer). Browsers can't send UDP, so the library sends its MPEG-TS stream here and the relay forwards it, unchanged, to the UDP target the page asks for. Only targets on an allowlist are accepted.

```sh
ALLOW="10.0.0.5:*" npx web-video-streamer-relay
```

| Variable | Default | |
|---|---|---|
| `PORT` | 8090 | WebSocket and HTTP (`GET /cert-hash`) port, TCP |
| `WT_PORT` | 4433 | WebTransport port, UDP (`off` disables) |
| `ALLOW` | `127.0.0.1:*` | Allowed UDP destinations (`host:port`, `host:*`, `*`) |
| `DEFAULT_TARGET` | — | Target used when a client sends none |
| `TLS_CERT` / `TLS_KEY` | — | PEM certificate and key; otherwise a 13-day self-signed certificate is generated at startup (restart before it expires) |
| `WT_HOSTNAMES` | localhost + host IPs | Names in the generated certificate |

Programmatic use: `startRelay()`, `createRelay()`, `createWebTransportRelay()`, `generateSelfSignedCertificate()`.

Requires Node 22+. WebTransport uses a native libquiche addon (prebuilt for Linux, macOS and Windows on x64, plus arm on Linux and macOS).

Full documentation: https://github.com/clockard/web-video-streamer#readme

MIT License
