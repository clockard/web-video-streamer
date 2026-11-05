#!/usr/bin/env node
/**
 * Environment:
 *   PORT            WebSocket / HTTP listen port (default 8090)
 *   WT_PORT         WebTransport (HTTP/3, UDP) port (default 4433; "off" disables)
 *   ALLOW           comma-separated allowed UDP outputs, e.g. "10.0.0.5:5000,127.0.0.1:*" (default "*", any address)
 *   AUTO_HOST       host for outputs auto-assigned to new devices (default 127.0.0.1)
 *   AUTO_PORTS      port range for auto-assigned outputs (default 5000-5099)
 *   MAPPINGS_FILE   JSON file keeping device -> output mappings (default ./relay-mappings.json; "off" = memory only)
 *   ADMIN_TOKEN     if set, the /streams API requires "Authorization: Bearer <token>"
 *   TLS_CERT/TLS_KEY  certificate and key (PEM). Used for wss:// and WebTransport;
 *                     without them WebTransport uses a generated 13-day self-signed
 *                     certificate whose hash is served at GET /cert-hash.
 *   WT_HOSTNAMES    comma-separated names/IPs for the generated certificate (default: localhost + this host's IPs)
 */
import { readFileSync } from 'node:fs';
import { startRelay } from './server.js';
import { parsePortRange } from './streams.js';

const log = (msg: string) => console.log(`${new Date().toISOString()} ${msg}`);
const allow = (process.env.ALLOW ?? '*').split(',').map((s) => s.trim()).filter(Boolean);
const mappingsFile = process.env.MAPPINGS_FILE ?? 'relay-mappings.json';

const relay = await startRelay({
  port: Number(process.env.PORT ?? 8090),
  webTransportPort: process.env.WT_PORT === 'off' ? undefined : Number(process.env.WT_PORT ?? 4433),
  allow,
  autoHost: process.env.AUTO_HOST,
  autoPorts: process.env.AUTO_PORTS ? parsePortRange(process.env.AUTO_PORTS) : undefined,
  mappingsFile: mappingsFile === 'off' ? undefined : mappingsFile,
  adminToken: process.env.ADMIN_TOKEN || undefined,
  tls:
    process.env.TLS_CERT && process.env.TLS_KEY
      ? { cert: readFileSync(process.env.TLS_CERT, 'utf8'), key: readFileSync(process.env.TLS_KEY, 'utf8') }
      : undefined,
  hostnames: process.env.WT_HOSTNAMES?.split(','),
  log,
});

log(`websocket relay listening on ${relay.secure ? 'wss' : 'ws'}://0.0.0.0:${relay.port}, allowed outputs: ${allow.join(', ')}`);
log(`stream API at http${relay.secure ? 's' : ''}://0.0.0.0:${relay.port}/streams${process.env.ADMIN_TOKEN ? ' (admin token required)' : ''}`);
if (relay.webTransportPort) {
  const expiry = relay.secure ? '' : `; self-signed certificate valid until ${relay.certificate!.notAfter.toISOString()} (restart before then)`;
  log(`webtransport relay listening on https://0.0.0.0:${relay.webTransportPort}${relay.webTransportPath} (UDP)${expiry}`);
}
