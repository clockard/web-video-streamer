import type { Server as HttpServer } from 'node:http';
import type { Server as HttpsServer } from 'node:https';
import { WebSocketServer, type WebSocket } from 'ws';
import { clientAddress, type StreamRegistry, type StreamSession } from './streams.js';

/** 7 TS packets: the conventional MPEG-TS-over-UDP datagram size. */
export const DATAGRAM_SIZE = 7 * 188;

export interface RelayTarget {
  host: string;
  port: number;
}

export interface RelayOptions {
  /** Listen port when no server is given. */
  port?: number;
  /** Attach to an existing HTTP(S) server instead of listening on a port. */
  server?: HttpServer | HttpsServer;
  /** URL path clients connect to. */
  path?: string;
  /** Device → UDP output routing shared with the WebTransport relay. */
  registry: StreamRegistry;
  log?: (msg: string) => void;
}

export function parseTarget(value: string): RelayTarget {
  const url = new URL(value.includes('://') ? value : `udp://${value}`);
  if (url.protocol !== 'udp:') throw new Error(`unsupported protocol ${url.protocol}`);
  const port = Number(url.port);
  if (!url.hostname || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`invalid target ${value}`);
  }
  return { host: url.hostname.replace(/^\[|\]$/g, ''), port };
}

export function isAllowed(target: RelayTarget, allow: string[]): boolean {
  return allow.some((rule) => {
    if (rule === '*') return true;
    const i = rule.lastIndexOf(':');
    const host = rule.slice(0, i).replace(/^\[|\]$/g, '');
    const port = rule.slice(i + 1);
    return host === target.host && (port === '*' || Number(port) === target.port);
  });
}

/**
 * Re-chunks a byte stream of TS packets into UDP datagrams: full
 * 1316-byte datagrams where possible, then whatever whole packets remain, so
 * only a partial packet (< 188 bytes) is ever held back.
 */
export class TsDatagramChunker {
  private pending = Buffer.alloc(0);

  constructor(private readonly emit: (datagram: Buffer) => void) {}

  push(data: Uint8Array): void {
    const buf = this.pending.length ? Buffer.concat([this.pending, data]) : Buffer.from(data);
    const whole = buf.length - (buf.length % 188);
    for (let i = 0; i < whole; i += DATAGRAM_SIZE) this.emit(buf.subarray(i, Math.min(i + DATAGRAM_SIZE, whole)));
    this.pending = Buffer.from(buf.subarray(whole));
  }
}

export function createRelay(options: RelayOptions): WebSocketServer {
  const log = options.log ?? (() => {});
  const wss = new WebSocketServer({
    port: options.server ? undefined : options.port,
    server: options.server,
    path: options.path,
  });

  wss.on('connection', (ws: WebSocket, req) => {
    const peer = clientAddress(req.socket.remoteAddress, req.headers['x-forwarded-for']);
    const params = new URL(req.url ?? '/', 'http://relay').searchParams;

    let session: StreamSession;
    try {
      session = options.registry.attach({
        deviceId: params.get('device'),
        name: params.get('name'),
        transport: 'websocket',
        peer,
        close: (code, reason) => ws.close(code, reason),
      });
    } catch (err) {
      log(`rejecting ${peer}: ${(err as Error).message}`);
      ws.close(1008, (err as Error).message);
      return;
    }

    ws.on('message', (data, isBinary) => {
      if (!isBinary) return;
      const buf = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer);
      for (let i = 0; i < buf.length; i += DATAGRAM_SIZE) session.send(buf.subarray(i, i + DATAGRAM_SIZE));
    });

    ws.on('close', () => session.detach());
  });

  return wss;
}
