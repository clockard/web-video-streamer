#!/usr/bin/env -S npx tsx
/**
 * Environment:
 *   PORT            WebSocket / HTTP listen port (default 8090)
 *   WT_PORT         WebTransport (HTTP/3, UDP) port (default 4433; "off" disables)
 *   ALLOW           comma-separated allowed targets, e.g. "10.0.0.5:5000,127.0.0.1:*" (default "127.0.0.1:*")
 *   DEFAULT_TARGET  target used when a client does not send one
 *   TLS_CERT/TLS_KEY  certificate and key (PEM). Used for wss:// and WebTransport;
 *                     without them WebTransport uses a generated 13-day self-signed
 *                     certificate whose hash is served at GET /cert-hash.
 *   WT_HOSTNAMES    comma-separated names/IPs for the generated certificate (default: localhost + this host's IPs)
 */
import { readFileSync } from 'node:fs';
import { startRelay } from './server';

const log = (msg: string) => console.log(`${new Date().toISOString()} ${msg}`);
const allow = (process.env.ALLOW ?? '127.0.0.1:*').split(',').map((s) => s.trim()).filter(Boolean);

const relay = await startRelay({
  port: Number(process.env.PORT ?? 8090),
  webTransportPort: process.env.WT_PORT === 'off' ? undefined : Number(process.env.WT_PORT ?? 4433),
  allow,
  defaultTarget: process.env.DEFAULT_TARGET,
  tls:
    process.env.TLS_CERT && process.env.TLS_KEY
      ? { cert: readFileSync(process.env.TLS_CERT, 'utf8'), key: readFileSync(process.env.TLS_KEY, 'utf8') }
      : undefined,
  hostnames: process.env.WT_HOSTNAMES?.split(','),
  log,
});

log(`websocket relay listening on ${relay.secure ? 'wss' : 'ws'}://0.0.0.0:${relay.port}, allowed targets: ${allow.join(', ')}`);
if (relay.webTransportPort) {
  const expiry = relay.secure ? '' : `; self-signed certificate valid until ${relay.certificate!.notAfter.toISOString()} (restart before then)`;
  log(`webtransport relay listening on https://0.0.0.0:${relay.webTransportPort}${relay.webTransportPath} (UDP)${expiry}`);
}
