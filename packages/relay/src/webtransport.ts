/**
 * WebTransport (HTTP/3) side of the relay.
 *
 * Protocol, per session:
 *  1. The client opens a bidirectional control stream and writes one JSON
 *     line: {"device": "<id>", "name"?: "<label>", "mode": "datagram" | "stream"}.
 *  2. The relay answers {"ok": true} or {"error": "..."} (then closes). The
 *     device's UDP output comes from the stream registry, not the client.
 *  3. Video arrives either as datagrams (each a whole number of TS packets,
 *     forwarded as one UDP datagram) or on one unidirectional stream
 *     (re-chunked into 1316-byte datagrams).
 */
import { Http3Server } from '@fails-components/webtransport';
import { randomBytes } from 'node:crypto';
import { TsDatagramChunker, type RelayOptions } from './relay.js';
import type { StreamSession } from './streams.js';

export const WEBTRANSPORT_PATH = '/stream';

export interface WebTransportRelayOptions extends Pick<RelayOptions, 'registry' | 'log'> {
  port: number;
  /** Listen address (default "::", which accepts IPv4 and IPv6; Windows resolves localhost to ::1 first). */
  host?: string;
  cert: string;
  privateKey: string;
}

interface Session {
  ready: Promise<void>;
  closed: Promise<unknown>;
  close(info?: { closeCode?: number; reason?: string }): void;
  incomingBidirectionalStreams: ReadableStream<{ readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array> }>;
  incomingUnidirectionalStreams: ReadableStream<ReadableStream<Uint8Array>>;
  datagrams: { readable: ReadableStream<Uint8Array> };
  peerAddress?: string;
}

interface ControlRequest {
  device?: unknown;
  name?: unknown;
  mode?: 'datagram' | 'stream';
}

/** "1.2.3.4:5678" or "[::1]:5678" → the host part. */
function peerHost(address: string | undefined): string | undefined {
  const host = address?.match(/^\[(.*)\]:\d+$/)?.[1] ?? address?.match(/^([^:]*):\d+$/)?.[1] ?? address;
  return host?.replace(/^::ffff:/, '');
}

/** Read one newline-terminated JSON message from a stream. */
async function readJsonLine(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<ControlRequest> {
  const decoder = new TextDecoder();
  let text = '';
  while (!text.includes('\n')) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
    if (text.length > 4096) throw new Error('control message too long');
  }
  return JSON.parse(text.split('\n')[0]) as ControlRequest;
}

export async function createWebTransportRelay(options: WebTransportRelayOptions) {
  const log = options.log ?? (() => {});
  const server = new Http3Server({
    port: options.port,
    host: options.host ?? '::',
    secret: randomBytes(16).toString('hex'),
    cert: options.cert,
    privKey: options.privateKey,
    // The typings require defaultDatagramsReadableMode, but it is optional at
    // runtime; the default (non-byte) mode yields one Uint8Array per datagram.
  } as unknown as ConstructorParameters<typeof Http3Server>[0]);
  server.startServer();
  await server.ready;

  void (async () => {
    const sessions = (await server.sessionStream(WEBTRANSPORT_PATH)).getReader() as ReadableStreamDefaultReader<Session>;
    while (true) {
      const { value: session, done } = await sessions.read();
      if (done) break;
      handleSession(session, options, log).catch((err) => log(`webtransport session error: ${(err as Error).message}`));
    }
  })();

  return {
    address: () => server.address() as { host: string; port: number } | null,
    close: () => server.stopServer(),
  };
}

async function handleSession(session: Session, options: WebTransportRelayOptions, log: (msg: string) => void) {
  await session.ready;
  const bidi = await session.incomingBidirectionalStreams.getReader().read();
  if (bidi.done) return;
  const control = bidi.value;
  const writer = control.writable.getWriter();
  const reply = (msg: object) => writer.write(new TextEncoder().encode(`${JSON.stringify(msg)}\n`));

  let device: StreamSession;
  let mode: 'datagram' | 'stream';
  try {
    const request = await readJsonLine(control.readable.getReader());
    mode = request.mode === 'stream' ? 'stream' : 'datagram';
    device = options.registry.attach({
      deviceId: request.device,
      name: request.name,
      transport: `webtransport/${mode}`,
      peer: peerHost(session.peerAddress),
      close: (code, reason) => session.close({ closeCode: code, reason }),
    });
  } catch (err) {
    log(`rejecting webtransport session: ${(err as Error).message}`);
    await reply({ error: (err as Error).message }).catch(() => {});
    session.close({ closeCode: 1, reason: (err as Error).message });
    return;
  }
  const send = (datagram: Uint8Array) => device.send(datagram);
  await reply({ ok: true });

  const pump = async () => {
    if (mode === 'datagram') {
      const reader = session.datagrams.readable.getReader();
      while (true) {
        const { value, done } = await reader.read();
        if (done) return;
        send(value);
      }
    } else {
      const chunker = new TsDatagramChunker(send);
      const streams = session.incomingUnidirectionalStreams.getReader();
      while (true) {
        const { value: stream, done } = await streams.read();
        if (done) return;
        const reader = stream.getReader();
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          chunker.push(chunk.value);
        }
      }
    }
  };

  await Promise.race([pump(), session.closed]).catch(() => {});
  await session.closed.catch(() => {});
  device.detach();
}
