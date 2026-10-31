import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { networkInterfaces } from 'node:os';
import { certificateHash, generateSelfSignedCertificate, type ServerCertificate } from './cert.js';
import { createRelay } from './relay.js';
import { StreamError, StreamRegistry } from './streams.js';
import { createWebTransportRelay, WEBTRANSPORT_PATH } from './webtransport.js';

export interface RelayServerOptions {
  /** WebSocket / HTTP port (0 = any free port). */
  port: number;
  /** WebTransport UDP port (0 = any free port); undefined disables WebTransport. */
  webTransportPort?: number;
  /** Allowed UDP outputs as "host:port", "host:*" or "*". */
  allow: string[];
  /** Host for outputs auto-assigned to new devices (default 127.0.0.1). */
  autoHost?: string;
  /** Inclusive port range for auto-assigned outputs (default 5000–5099). */
  autoPorts?: [number, number];
  /** JSON file that keeps device → output mappings across restarts; undefined = memory only. */
  mappingsFile?: string;
  /** When set, the /streams API requires "Authorization: Bearer <adminToken>". */
  adminToken?: string;
  /** PEM certificate and key for wss:// and WebTransport; otherwise WebTransport uses a generated self-signed one. */
  tls?: { cert: string; key: string };
  /** Names/IPs for the generated certificate (default: localhost and this host's addresses). */
  hostnames?: string[];
  log?: (msg: string) => void;
}

const MAX_BODY = 4096;

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => {
      body += chunk;
      if (body.length > MAX_BODY) {
        reject(new StreamError('request body too large', 413));
        req.destroy();
      }
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

/**
 * Start the WebSocket relay, the HTTP API (GET /cert-hash, /streams) on one
 * HTTP(S) port and, optionally, the WebTransport relay on a UDP port.
 */
export async function startRelay(options: RelayServerOptions) {
  const log = options.log ?? (() => {});
  const { tls } = options;
  const registry = new StreamRegistry({
    allow: options.allow,
    autoHost: options.autoHost,
    autoPorts: options.autoPorts,
    mappingsFile: options.mappingsFile,
    log,
  });

  let wtCert: ServerCertificate | undefined;
  if (options.webTransportPort !== undefined) {
    wtCert = tls
      ? { cert: tls.cert, privateKey: tls.key, sha256: certificateHash(tls.cert), notAfter: new Date(0) }
      : await generateSelfSignedCertificate(
          options.hostnames ?? ['localhost', ...Object.values(networkInterfaces()).flatMap((l) => (l ?? []).map((i) => i.address))],
        );
  }

  const send = (res: ServerResponse, status: number, body?: unknown) => {
    res.writeHead(status, {
      'access-control-allow-origin': '*',
      'cache-control': 'no-store',
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    });
    res.end(body === undefined ? undefined : JSON.stringify(body));
  };

  // GET /streams lists devices and their UDP outputs; PUT /streams/<id> {"target"} changes one;
  // DELETE /streams/<id> forgets an offline device.
  const streamsApi = async (req: IncomingMessage, res: ServerResponse, deviceId: string | undefined) => {
    if (options.adminToken && req.headers.authorization !== `Bearer ${options.adminToken}`) {
      send(res, 401, { error: 'admin token required' });
      return;
    }
    if (req.method === 'GET' && !deviceId) {
      send(res, 200, { streams: registry.list(), allow: options.allow });
    } else if (req.method === 'GET' && deviceId) {
      const info = registry.info(deviceId);
      send(res, info ? 200 : 404, info ?? { error: 'unknown device' });
    } else if (req.method === 'PUT' && deviceId) {
      let body: { target?: unknown };
      try {
        body = JSON.parse(await readBody(req)) as { target?: unknown };
      } catch (err) {
        throw err instanceof StreamError ? err : new StreamError('body must be JSON like {"target": "udp://host:port"}', 400);
      }
      send(res, 200, registry.setTarget(deviceId, body?.target));
    } else if (req.method === 'DELETE' && deviceId) {
      registry.forget(deviceId);
      send(res, 204);
    } else {
      send(res, 405, { error: 'method not allowed' });
    }
  };

  const handler = (req: IncomingMessage, res: ServerResponse) => {
    const path = req.url?.split('?')[0] ?? '/';
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET, PUT, DELETE, OPTIONS',
        'access-control-allow-headers': 'authorization, content-type',
        'access-control-max-age': '600',
      });
      res.end();
      return;
    }
    // Lets pages trust the self-signed WebTransport certificate via serverCertificateHashes.
    if (req.method === 'GET' && path === '/cert-hash' && wtCert) {
      send(res, 200, { sha256: wtCert.sha256 });
      return;
    }
    const match = /^\/streams(?:\/([^/]+))?\/?$/.exec(path);
    if (match) {
      let deviceId: string | undefined;
      try {
        deviceId = match[1] && decodeURIComponent(match[1]);
      } catch {
        send(res, 400, { error: 'invalid device id' });
        return;
      }
      streamsApi(req, res, deviceId).catch((err: Error) => {
        if (!res.headersSent) send(res, err instanceof StreamError ? err.status : 500, { error: err.message });
      });
      return;
    }
    send(res, 404);
  };
  const server = tls ? createHttpsServer({ cert: tls.cert, key: tls.key }, handler) : createHttpServer(handler);
  const wss = createRelay({ server, registry, log });
  await new Promise<void>((resolve) => server.listen(options.port, resolve));
  const port = (server.address() as { port: number }).port;

  const wt =
    wtCert &&
    (await createWebTransportRelay({
      port: options.webTransportPort!,
      cert: wtCert.cert,
      privateKey: wtCert.privateKey,
      registry,
      log,
    }));

  return {
    port,
    webTransportPort: wt?.address()?.port,
    webTransportPath: WEBTRANSPORT_PATH,
    certificate: wtCert,
    secure: !!tls,
    registry,
    close() {
      wt?.close();
      wss.close();
      registry.close();
      server.close();
    },
  };
}
