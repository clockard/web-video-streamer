# web-video-streamer-relay

WebTransport (HTTP/3) and WebSocket → UDP relay for [`web-video-streamer`](https://www.npmjs.com/package/web-video-streamer). Browsers can't send UDP, so the library sends its MPEG-TS stream here, identified by a device ID, and the relay forwards it unchanged to that device's UDP output. New devices get a port from a pool automatically; mappings are saved to a file and can be changed (even mid-stream) through the `/streams` HTTP API. Only outputs on the `ALLOW` list are used (by default any address, so narrow it or set `ADMIN_TOKEN` on a shared network).

```sh
ALLOW="10.0.0.5:*" AUTO_HOST=10.0.0.5 npx web-video-streamer-relay
curl -s localhost:8090/streams   # devices and their outputs
```

| Variable | Default | |
|---|---|---|
| `PORT` | 8090 | WebSocket and HTTP (`/cert-hash`, `/streams`) port, TCP |
| `WT_PORT` | 4433 | WebTransport port, UDP (`off` disables) |
| `ALLOW` | `*` | Allowed UDP destinations (`host:port`, `host:*`, `*` = any address). Set `ADMIN_TOKEN` if others can reach the `/streams` API |
| `AUTO_HOST` | `127.0.0.1` | Host of outputs auto-assigned to new devices |
| `AUTO_PORTS` | `5000-5099` | Port range for auto-assigned outputs |
| `MAPPINGS_FILE` | `./relay-mappings.json` | Device → output mappings kept across restarts (`off` = memory only) |
| `ADMIN_TOKEN` | — | If set, the `/streams` API requires `Authorization: Bearer <token>` |
| `TLS_CERT` / `TLS_KEY` | — | PEM certificate and key; otherwise a 13-day self-signed certificate is generated at startup (restart before it expires) |
| `WT_HOSTNAMES` | localhost + host IPs | Names in the generated certificate |

Programmatic use: `startRelay()`, `StreamRegistry`, `createRelay()`, `createWebTransportRelay()`, `generateSelfSignedCertificate()`.

Requires Node 22+. WebTransport uses a native libquiche addon (prebuilt for Linux, macOS and Windows on x64, plus arm on Linux and macOS).

npm 12+ blocks dependency install scripts by default, which leaves that addon uninstalled and WebTransport fails to load (`Cannot find module '../build/Release/webtransport.node'`). Allow it:

```sh
# installed in a project: records it under allowScripts in your package.json
npm install web-video-streamer-relay
npm approve-scripts @fails-components/webtransport-transport-http3-quiche && npm rebuild

# run without installing
npx --allow-scripts=@fails-components/webtransport-transport-http3-quiche web-video-streamer-relay
```

Full documentation: https://github.com/clockard/web-video-streamer#readme

MIT License
