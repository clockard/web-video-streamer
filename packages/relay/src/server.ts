import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { networkInterfaces } from 'node:os';
import { certificateHash, generateSelfSignedCertificate, type ServerCertificate } from './cert';
import { createRelay } from './relay';
import { createWebTransportRelay, WEBTRANSPORT_PATH } from './webtransport';

export interface RelayServerOptions {
  /** WebSocket / HTTP port (0 = any free port). */
  port: number;
  /** WebTransport UDP port (0 = any free port); undefined disables WebTransport. */
  webTransportPort?: number;
  allow: string[];
  defaultTarget?: string;
  /** PEM certificate and key for wss:// and WebTransport; otherwise WebTransport uses a generated self-signed one. */
  tls?: { cert: string; key: string };
  /** Names/IPs for the generated certificate (default: localhost and this host's addresses). */
  hostnames?: string[];
  log?: (msg: string) => void;
}

/**
 * Start the WebSocket relay (plus GET /cert-hash) on one HTTP(S) port and,
 * optionally, the WebTransport relay on a UDP port.
 */
export async function startRelay(options: RelayServerOptions) {
  const log = options.log ?? (() => {});
  const { tls } = options;

  let wtCert: ServerCertificate | undefined;
  if (options.webTransportPort !== undefined) {
    wtCert = tls
      ? { cert: tls.cert, privateKey: tls.key, sha256: certificateHash(tls.cert), notAfter: new Date(0) }
      : await generateSelfSignedCertificate(
          options.hostnames ?? ['localhost', ...Object.values(networkInterfaces()).flatMap((l) => (l ?? []).map((i) => i.address))],
        );
  }

  // GET /cert-hash lets pages trust the self-signed WebTransport certificate via serverCertificateHashes.
  const handler = (req: IncomingMessage, res: ServerResponse) => {
    if (req.method === 'GET' && req.url?.split('?')[0] === '/cert-hash' && wtCert) {
      res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ sha256: wtCert.sha256 }));
      return;
    }
    res.writeHead(404).end();
  };
  const server = tls ? createHttpsServer({ cert: tls.cert, key: tls.key }, handler) : createHttpServer(handler);
  const wss = createRelay({ server, allow: options.allow, defaultTarget: options.defaultTarget, log });
  await new Promise<void>((resolve) => server.listen(options.port, resolve));
  const port = (server.address() as { port: number }).port;

  const wt =
    wtCert &&
    (await createWebTransportRelay({
      port: options.webTransportPort!,
      cert: wtCert.cert,
      privateKey: wtCert.privateKey,
      allow: options.allow,
      defaultTarget: options.defaultTarget,
      log,
    }));

  return {
    port,
    webTransportPort: wt?.address()?.port,
    webTransportPath: WEBTRANSPORT_PATH,
    certificate: wtCert,
    secure: !!tls,
    close() {
      wt?.close();
      wss.close();
      server.close();
    },
  };
}
