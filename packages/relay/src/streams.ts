/**
 * Device → UDP output routing. Clients identify themselves with a device ID;
 * the relay decides where each device's stream goes, auto-assigning a port
 * from a pool the first time a device is seen and remembering it.
 */
import { createSocket, type Socket } from 'node:dgram';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { isAllowed, parseTarget, type RelayTarget } from './relay.js';

/** WebSocket / WebTransport close code: a newer connection from the same device took over. */
export const REPLACED_CLOSE_CODE = 4001;

const DEVICE_ID = /^[A-Za-z0-9._:-]{1,64}$/;

export interface StreamMapping {
  target: string;
  name?: string;
  /** 'auto' = taken from the port pool, 'manual' = set through the API. */
  assigned: 'auto' | 'manual';
  updatedAt: string;
}

export interface StreamInfo extends StreamMapping {
  deviceId: string;
  connected: boolean;
  transport?: string;
  /** Client IP of the live (or last) connection. */
  peer?: string;
  connectedAt?: string;
  lastSeen?: string;
  /** Bits per second over the last second while connected. */
  bitrate: number;
  /** Bytes forwarded by the live (or last) connection. */
  bytes: number;
}

export interface StreamRegistryOptions {
  allow: string[];
  /** Host for auto-assigned outputs (default 127.0.0.1). */
  autoHost?: string;
  /** Inclusive port range for auto-assigned outputs (default 5000–5099). */
  autoPorts?: [number, number];
  /** JSON file the mappings are kept in; undefined keeps them in memory only. */
  mappingsFile?: string;
  log?: (msg: string) => void;
}

export interface AttachOptions {
  deviceId: unknown;
  name?: unknown;
  transport: string;
  peer?: string;
  /** Called when the relay ends this connection (e.g. replaced by a newer one). */
  close: (code: number, reason: string) => void;
}

export interface StreamSession {
  readonly deviceId: string;
  readonly target: RelayTarget;
  /** Send one UDP datagram to the device's current output. */
  send(datagram: Uint8Array): void;
  detach(): void;
}

/** Error whose message is safe to show to clients; status is the HTTP status for the API. */
export class StreamError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

interface Live {
  session: StreamSession;
  target: RelayTarget;
  socket: Socket;
  transport: string;
  close: AttachOptions['close'];
  bitrate: number;
  windowBytes: number;
}

interface History {
  peer?: string;
  transport?: string;
  connectedAt?: string;
  lastSeen?: string;
  bytes: number;
}

export function parsePortRange(value: string): [number, number] {
  const [a, b = a] = value.split('-').map((s) => Number(s.trim()));
  if (!Number.isInteger(a) || !Number.isInteger(b) || a < 1 || b > 65535 || a > b) throw new Error(`invalid port range ${value}`);
  return [a, b];
}

const formatTarget = (t: RelayTarget) => `udp://${t.host.includes(':') ? `[${t.host}]` : t.host}:${t.port}`;
const socketType = (t: RelayTarget) => (t.host.includes(':') ? 'udp6' : 'udp4');

export class StreamRegistry {
  private readonly mappings = new Map<string, StreamMapping>();
  private readonly live = new Map<string, Live>();
  private readonly history = new Map<string, History>();
  private readonly autoHost: string;
  private readonly autoPorts: [number, number];
  private readonly log: (msg: string) => void;
  private readonly timer: ReturnType<typeof setInterval>;

  constructor(private readonly options: StreamRegistryOptions) {
    this.autoHost = options.autoHost ?? '127.0.0.1';
    this.autoPorts = options.autoPorts ?? [5000, 5099];
    this.log = options.log ?? (() => {});
    if (options.mappingsFile) this.load(options.mappingsFile);
    if (!isAllowed({ host: this.autoHost, port: this.autoPorts[0] }, options.allow)) {
      this.log(`warning: auto-assigned outputs (${this.autoHost}:${this.autoPorts.join('-')}) are not covered by the allowlist`);
    }
    this.timer = setInterval(() => {
      for (const l of this.live.values()) {
        l.bitrate = l.windowBytes * 8;
        l.windowBytes = 0;
      }
    }, 1000);
    this.timer.unref();
  }

  /** Register a connection for a device and open its UDP output. Throws StreamError if it cannot. */
  attach(options: AttachOptions): StreamSession {
    const deviceId = options.deviceId;
    if (typeof deviceId !== 'string' || !DEVICE_ID.test(deviceId)) {
      throw new StreamError('missing or invalid device id (1-64 of A-Z a-z 0-9 . _ : -)', 400);
    }
    const name = typeof options.name === 'string' && options.name ? options.name.slice(0, 100) : undefined;

    let mapping = this.mappings.get(deviceId);
    if (!mapping) {
      mapping = { target: formatTarget({ host: this.autoHost, port: this.freePort() }), assigned: 'auto', updatedAt: new Date().toISOString() };
      this.mappings.set(deviceId, mapping);
      this.log(`device ${deviceId} assigned ${mapping.target}`);
    }
    if (name && name !== mapping.name) mapping.name = name;
    this.save();

    const target = parseTarget(mapping.target);
    if (!isAllowed(target, this.options.allow)) {
      throw new StreamError(`output ${mapping.target} for device ${deviceId} is not allowed`, 403);
    }

    const previous = this.live.get(deviceId);
    if (previous) {
      this.log(`device ${deviceId}: replacing previous ${previous.transport} connection`);
      this.end(deviceId, previous);
      previous.close(REPLACED_CLOSE_CODE, 'replaced by a newer connection from this device');
    }

    const history: History = { peer: options.peer, transport: options.transport, connectedAt: new Date().toISOString(), bytes: 0 };
    this.history.set(deviceId, history);

    const registry = this;
    const live: Live = {
      target,
      socket: this.openSocket(deviceId, target),
      transport: options.transport,
      close: options.close,
      bitrate: 0,
      windowBytes: 0,
      session: {
        deviceId,
        get target() {
          return live.target;
        },
        send(datagram) {
          if (registry.live.get(deviceId) !== live) return;
          live.socket.send(datagram, live.target.port, live.target.host);
          history.bytes += datagram.byteLength;
          live.windowBytes += datagram.byteLength;
        },
        detach() {
          if (registry.live.get(deviceId) !== live) return;
          registry.end(deviceId, live);
          registry.log(`device ${deviceId} disconnected after ${(history.bytes / 1e6).toFixed(1)} MB`);
        },
      },
    };
    this.live.set(deviceId, live);
    this.log(`device ${deviceId}${name ? ` (${name})` : ''} from ${options.peer ?? 'unknown'} via ${options.transport} -> ${mapping.target}`);
    return live.session;
  }

  /** Change a device's output; a live stream moves to it immediately. */
  setTarget(deviceId: string, value: unknown): StreamInfo {
    if (!DEVICE_ID.test(deviceId)) throw new StreamError('invalid device id', 400);
    if (typeof value !== 'string' || !value) throw new StreamError('target is required', 400);
    let target: RelayTarget;
    try {
      target = parseTarget(value);
    } catch (err) {
      throw new StreamError((err as Error).message, 400);
    }
    if (!isAllowed(target, this.options.allow)) throw new StreamError(`target ${target.host}:${target.port} not allowed`, 403);

    const formatted = formatTarget(target);
    const mapping = this.mappings.get(deviceId);
    this.mappings.set(deviceId, { ...mapping, target: formatted, assigned: 'manual', updatedAt: new Date().toISOString() });
    this.save();

    const live = this.live.get(deviceId);
    if (live) {
      if (socketType(live.target) !== socketType(target)) {
        live.socket.close();
        live.socket = this.openSocket(deviceId, target);
      }
      live.target = target;
    }
    this.log(`device ${deviceId} output set to ${formatted}`);
    return this.info(deviceId)!;
  }

  /** Remove an offline device's mapping, freeing its port. */
  forget(deviceId: string): void {
    if (this.live.has(deviceId)) throw new StreamError('device is streaming; stop it first', 409);
    if (!this.mappings.delete(deviceId)) throw new StreamError('unknown device', 404);
    this.history.delete(deviceId);
    this.save();
    this.log(`device ${deviceId} forgotten`);
  }

  list(): StreamInfo[] {
    return [...this.mappings.keys()].map((id) => this.info(id)!).sort((a, b) => Number(b.connected) - Number(a.connected) || a.deviceId.localeCompare(b.deviceId));
  }

  info(deviceId: string): StreamInfo | undefined {
    const mapping = this.mappings.get(deviceId);
    if (!mapping) return undefined;
    const live = this.live.get(deviceId);
    const history = this.history.get(deviceId);
    return {
      deviceId,
      ...mapping,
      connected: !!live,
      transport: history?.transport,
      peer: history?.peer,
      connectedAt: history?.connectedAt,
      lastSeen: live ? new Date().toISOString() : history?.lastSeen,
      bitrate: live?.bitrate ?? 0,
      bytes: history?.bytes ?? 0,
    };
  }

  close(): void {
    clearInterval(this.timer);
    for (const [id, live] of this.live) this.end(id, live);
  }

  private end(deviceId: string, live: Live) {
    this.live.delete(deviceId);
    live.socket.close();
    const history = this.history.get(deviceId);
    if (history) history.lastSeen = new Date().toISOString();
  }

  private openSocket(deviceId: string, target: RelayTarget): Socket {
    const socket = createSocket(socketType(target));
    socket.on('error', (err) => {
      this.log(`device ${deviceId}: udp error ${err.message}`);
      const live = this.live.get(deviceId);
      if (live?.socket === socket) {
        this.end(deviceId, live);
        live.close(1011, 'udp error');
      }
    });
    return socket;
  }

  private freePort(): number {
    const used = new Set<number>();
    for (const m of this.mappings.values()) {
      try {
        const t = parseTarget(m.target);
        if (t.host === this.autoHost) used.add(t.port);
      } catch {
        // Ignore unparsable entries.
      }
    }
    for (let p = this.autoPorts[0]; p <= this.autoPorts[1]; p++) if (!used.has(p)) return p;
    throw new StreamError(`no free output ports left in ${this.autoPorts.join('-')}`, 503);
  }

  private load(file: string) {
    let data: { devices?: Record<string, StreamMapping> };
    try {
      data = JSON.parse(readFileSync(file, 'utf8')) as typeof data;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') this.log(`could not read ${file}: ${(err as Error).message}`);
      return;
    }
    for (const [id, m] of Object.entries(data.devices ?? {})) {
      if (DEVICE_ID.test(id) && typeof m?.target === 'string') this.mappings.set(id, m);
    }
    this.log(`loaded ${this.mappings.size} device mapping(s) from ${file}`);
  }

  private save() {
    const file = this.options.mappingsFile;
    if (!file) return;
    try {
      const tmp = `${file}.tmp`;
      writeFileSync(tmp, `${JSON.stringify({ devices: Object.fromEntries(this.mappings) }, null, 2)}\n`);
      renameSync(tmp, file);
    } catch (err) {
      this.log(`could not save ${file}: ${(err as Error).message}`);
    }
  }
}

/** Client IP; X-Forwarded-For is trusted only from loopback (a local reverse proxy such as Vite's). */
export function clientAddress(remoteAddress: string | undefined, forwardedFor: string | string[] | undefined): string | undefined {
  const remote = remoteAddress?.replace(/^::ffff:/, '');
  const loopback = remote === '127.0.0.1' || remote === '::1';
  const forwarded = Array.isArray(forwardedFor) ? forwardedFor[0] : forwardedFor;
  if (loopback && forwarded) return forwarded.split(',')[0].trim().replace(/^::ffff:/, '');
  return remote;
}
