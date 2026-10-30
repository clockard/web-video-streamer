import { createSocket, type Socket } from 'node:dgram';
import type { Server as HttpServer } from 'node:http';
import type { Server as HttpsServer } from 'node:https';
import { WebSocketServer, type WebSocket } from 'ws';

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
  /**
   * Allowed UDP destinations as "host:port", "host:*" or "*".
   * Prevents the relay from being used to send traffic to arbitrary hosts.
   */
  allow: string[];
  /** Used when a client does not request a target. */
  defaultTarget?: string;
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

/** Apply the default target and the allowlist; throws with a client-facing reason. */
export function resolveTarget(
  requested: string | null | undefined,
  options: Pick<RelayOptions, 'allow' | 'defaultTarget'>,
): RelayTarget {
  const value = requested || options.defaultTarget;
  if (!value) throw new Error('no target given');
  const target = parseTarget(value);
  if (!isAllowed(target, options.allow)) throw new Error(`target ${target.host}:${target.port} not allowed`);
  return target;
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
    const peer = req.socket.remoteAddress;
    const requested = new URL(req.url ?? '/', 'http://relay').searchParams.get('target');

    let target: RelayTarget;
    try {
      target = resolveTarget(requested, options);
    } catch (err) {
      log(`rejecting ${peer}: ${(err as Error).message}`);
      ws.close(1008, (err as Error).message);
      return;
    }

    const socket: Socket = createSocket(target.host.includes(':') ? 'udp6' : 'udp4');
    let bytes = 0;
    log(`${peer} -> udp://${target.host}:${target.port}`);

    socket.on('error', (err) => {
      log(`udp error for ${peer}: ${err.message}`);
      ws.close(1011, 'udp error');
    });

    ws.on('message', (data, isBinary) => {
      if (!isBinary) return;
      const buf = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer);
      for (let i = 0; i < buf.length; i += DATAGRAM_SIZE) {
        socket.send(buf.subarray(i, i + DATAGRAM_SIZE), target.port, target.host);
      }
      bytes += buf.length;
    });

    ws.on('close', () => {
      log(`${peer} closed after ${(bytes / 1e6).toFixed(1)} MB`);
      socket.close();
    });
  });

  return wss;
}
