/**
 * WebTransport (HTTP/3 / QUIC) connection to the relay.
 *
 * After the session opens, a bidirectional control stream carries one JSON
 * line {"device", "name", "mode"} and the relay's {"ok"} / {"error"} reply. Video then
 * goes either as datagrams (unreliable, like the UDP leg it feeds: lowest
 * latency, losses show as glitches until the next keyframe) or on one
 * unidirectional stream (reliable and ordered; delay can grow on bad links).
 */
import { REPLACED_CLOSE_CODE, type Transport, type TransportEvents } from './transport';

export type WebTransportMode = 'datagram' | 'stream';

export interface WebTransportTransportOptions {
  mode: WebTransportMode;
  deviceId: string;
  deviceName?: string;
  /** Base64 SHA-256 of a self-signed relay certificate (serverCertificateHashes). */
  serverCertificateHash?: string;
  connectTimeoutMs?: number;
  /** Datagrams older than this are discarded by the browser instead of being sent late. */
  datagramMaxAgeMs?: number;
}

const TS_PACKET = 188;

export function isWebTransportSupported(): boolean {
  return typeof (globalThis as { WebTransport?: unknown }).WebTransport === 'function';
}

/** Split TS data into datagram payloads of at most maxSize bytes, on packet boundaries. */
export function chunkForDatagrams(data: Uint8Array, maxSize: number): Uint8Array[] {
  const size = Math.max(TS_PACKET, maxSize - (maxSize % TS_PACKET));
  const chunks: Uint8Array[] = [];
  for (let i = 0; i < data.length; i += size) chunks.push(data.subarray(i, i + size));
  return chunks;
}

/** The relay refused the session (e.g. target not allowed); retrying will not help. */
class RejectedError extends Error {}

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms))),
  ]).finally(() => clearTimeout(timer));
}

type DatagramDuplex = WebTransportDatagramDuplexStream & {
  createWritable?: () => WritableStream<Uint8Array>;
  outgoingMaxAge?: number | null;
};

export class WebTransportTransport implements Transport {
  readonly kind: string;
  bytesSent = 0;
  private wt?: WebTransport;
  private writer?: WritableStreamDefaultWriter<Uint8Array>;
  private datagramSize = 6 * TS_PACKET;
  private pending = 0;
  private open = false;
  private closed = false;
  private retryTimer?: ReturnType<typeof setTimeout>;
  private retryDelay = 1000;

  constructor(
    private readonly url: string,
    private readonly options: WebTransportTransportOptions,
    private readonly events: TransportEvents,
  ) {
    this.kind = `webtransport/${options.mode}`;
  }

  get connected(): boolean {
    return this.open;
  }

  get bufferedAmount(): number {
    return this.pending;
  }

  async connect(): Promise<void> {
    await this.establish();
  }

  send(data: Uint8Array): void {
    if (!this.open || !this.writer) return;
    const parts = this.options.mode === 'datagram' ? chunkForDatagrams(data, this.datagramSize) : [data];
    for (const part of parts) {
      this.pending += part.byteLength;
      const done = () => (this.pending -= part.byteLength);
      this.writer.write(part).then(done, done);
    }
    this.bytesSent += data.byteLength;
  }

  close(): void {
    this.closed = true;
    this.open = false;
    clearTimeout(this.retryTimer);
    try {
      this.wt?.close({ closeCode: 0, reason: 'stopped' });
    } catch {
      // Already closed.
    }
  }

  private async establish(): Promise<void> {
    const timeout = this.options.connectTimeoutMs ?? 3000;
    const hash = this.options.serverCertificateHash;
    const wt = new WebTransport(this.url, {
      ...(hash ? { serverCertificateHashes: [{ algorithm: 'sha-256', value: base64ToBytes(hash) }] } : {}),
    });
    this.wt = wt;
    try {
      await withTimeout(wt.ready, timeout, 'WebTransport connection');
      const control = await wt.createBidirectionalStream();
      const writer = control.writable.getWriter();
      const { deviceId: device, deviceName: name, mode } = this.options;
      await writer.write(new TextEncoder().encode(`${JSON.stringify({ device, name, mode })}\n`));
      const reply = await withTimeout(readJsonLine(control.readable.getReader()), timeout, 'relay reply');
      if (!reply.ok) throw new RejectedError(reply.error ?? 'rejected by relay');

      if (this.options.mode === 'datagram') {
        const datagrams = wt.datagrams as DatagramDuplex;
        if ('outgoingMaxAge' in datagrams) datagrams.outgoingMaxAge = this.options.datagramMaxAgeMs ?? 500;
        this.datagramSize = datagrams.maxDatagramSize || this.datagramSize;
        this.writer = (datagrams.createWritable?.() ?? datagrams.writable).getWriter();
      } else {
        this.writer = (await wt.createUnidirectionalStream()).getWriter();
      }
    } catch (err) {
      try {
        wt.close();
      } catch {
        // Not open.
      }
      throw err instanceof Error ? err : new Error(String(err));
    }

    this.open = true;
    this.pending = 0;
    this.retryDelay = 1000;
    this.events.onOpen();
    wt.closed
      .catch(() => undefined)
      .then((info) => {
        this.open = false;
        if (this.closed || this.wt !== wt) return;
        const close = info as WebTransportCloseInfo | undefined;
        const reason = close?.reason || 'connection lost';
        // A newer connection from this device took over: don't fight it.
        if (close?.closeCode === REPLACED_CLOSE_CODE) {
          this.events.onClose(reason);
          return;
        }
        this.events.onClose(`${reason}, reconnecting`);
        this.scheduleReconnect();
      });
  }

  private scheduleReconnect() {
    this.retryTimer = setTimeout(() => {
      if (this.closed) return;
      this.establish().catch((err) => {
        if (this.closed) return;
        if (err instanceof RejectedError) {
          this.events.onClose(err.message);
          return;
        }
        this.scheduleReconnect();
      });
    }, this.retryDelay);
    this.retryDelay = Math.min(this.retryDelay * 2, 10_000);
  }
}

async function readJsonLine(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<{ ok?: boolean; error?: string }> {
  const decoder = new TextDecoder();
  let text = '';
  while (!text.includes('\n')) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  reader.releaseLock();
  return JSON.parse(text.split('\n')[0] || '{}');
}

function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
