/**
 * Publish H.264 video and AAC/Opus audio to a Media over QUIC server
 * (MediaMTX) over WebTransport, as MOQT draft 22 with an MSF catalog and LOC
 * objects. It follows MediaMTX's own browser publisher (v1.21), which is the
 * only server this is tested against.
 *
 * The session: CLIENT_SETUP / SERVER_SETUP, then once the first keyframe
 * arrives (the codec is only known then) the catalog and one PUBLISH per
 * track, each answered by REQUEST_OK or REQUEST_ERROR. Every frame is then a
 * group of its own on a new unidirectional stream.
 */
import { RejectedError, withTimeout } from '../webtransport';
import type { TransportEvents } from '../transport';
import { buildCatalog, VIDEO_CLOCK_RATE, type MoqTracks } from './catalog';
import { AvcPackager, encodeGroup } from './loc';
import {
  authorizationValue,
  decodeRequestError,
  encodeClientSetup,
  encodePublish,
  MOQT_PROTOCOL,
  MSG_REQUEST_ERROR,
  MSG_REQUEST_OK,
  MSG_SETUP,
  type MoqCredentials,
} from './messages';
import { StreamReader } from './varint';

export interface MoqPublisherOptions {
  /** WebTransport URL of the stream, e.g. "https://mediamtx.example.com:8892/phone-chris". */
  url: string;
  /**
   * Where to fetch the hex SHA-256 of the server's self-signed certificate.
   * Default `<url>/fingerprint` (MediaMTX serves it there). false skips pinning
   * for a server with a publicly trusted certificate.
   */
  fingerprintUrl?: string | false;
  credentials?: MoqCredentials;
  connectTimeoutMs?: number;
  /** The tracks to announce; called at the first keyframe. Returning undefined delays publishing. */
  tracks: () => MoqTracks | undefined;
}

/** The namespace MediaMTX expects; the stream is named by the URL path. */
const NAMESPACE = ['stream'];
const CATALOG_ALIAS = 0;
const VIDEO_ALIAS = 1;
const AUDIO_ALIAS = 2;
/** Frames held while PUBLISH is in flight (a few seconds of video and audio). */
const MAX_QUEUED = 300;

interface Connection {
  wt: WebTransport;
  /** Bytes handed to streams that have not finished yet. */
  pending: number;
  state: 'setup' | 'publishing' | 'published';
  tracks?: MoqTracks;
  queue: { alias: number; payload: Uint8Array; timestamp: number }[];
  groups: Map<number, number>;
  /** Video is skipped until the next keyframe (at the start, and after the queue overflows). */
  needKeyframe: boolean;
}

export class MoqPublisher {
  readonly kind = 'moq';
  bytesSent = 0;
  private conn?: Connection;
  private wt?: WebTransport;
  private closed = false;
  private retryTimer?: ReturnType<typeof setTimeout>;
  private retryDelay = 1000;
  private readonly avc = new AvcPackager();
  private readonly authorization?: string;

  constructor(
    private readonly options: MoqPublisherOptions,
    private readonly events: TransportEvents,
  ) {
    this.authorization = authorizationValue(options.credentials);
  }

  get connected(): boolean {
    return !!this.conn;
  }

  get bufferedAmount(): number {
    return this.conn?.pending ?? 0;
  }

  /** Resolves once the session is set up; rejects if it cannot connect. */
  async connect(): Promise<void> {
    await this.establish();
  }

  /** One H.264 access unit in Annex-B format. Dropped while disconnected. */
  writeVideo(annexB: Uint8Array, timestampUs: number, keyframe: boolean): void {
    const c = this.conn;
    if (!c || (c.needKeyframe && !keyframe)) return;
    if (c.state === 'setup') {
      this.startPublishing(c);
      if (c.state === 'setup') return; // Tracks not known yet: try again at the next keyframe.
    }
    c.needKeyframe = false;
    this.enqueue(c, VIDEO_ALIAS, this.avc.pack(annexB, keyframe), (timestampUs * VIDEO_CLOCK_RATE) / 1e6);
  }

  /** One raw AAC (no ADTS) or Opus frame. Dropped until video has started. */
  writeAudio(raw: Uint8Array, timestampUs: number): void {
    const c = this.conn;
    const audio = c?.tracks?.audio;
    if (!c || !audio) return;
    this.enqueue(c, AUDIO_ALIAS, raw, (timestampUs * audio.sampleRate) / 1e6);
  }

  close(): void {
    this.closed = true;
    this.conn = undefined;
    clearTimeout(this.retryTimer);
    try {
      this.wt?.close({ closeCode: 0, reason: 'stopped' });
    } catch {
      // Already closed.
    }
  }

  private enqueue(c: Connection, alias: number, payload: Uint8Array, timestamp: number) {
    if (c.state === 'published') {
      this.send(c, alias, payload, timestamp);
    } else if (c.state === 'publishing') {
      if (c.queue.length < MAX_QUEUED) c.queue.push({ alias, payload, timestamp });
      else if (alias === VIDEO_ALIAS) c.needKeyframe = true;
    }
  }

  private startPublishing(c: Connection) {
    const tracks = this.options.tracks();
    if (!tracks) return;
    c.tracks = tracks;
    c.state = 'publishing';
    this.publish(c, tracks).then(
      () => {
        if (this.conn !== c) return;
        c.state = 'published';
        for (const q of c.queue.splice(0)) this.send(c, q.alias, q.payload, q.timestamp);
      },
      (err: Error) => {
        if (this.conn !== c) return;
        if (err instanceof RejectedError) this.reject(err.message);
        else this.drop(c);
      },
    );
  }

  private async publish(c: Connection, tracks: MoqTracks) {
    const timeout = this.options.connectTimeoutMs ?? 5000;
    const catalog = new TextEncoder().encode(buildCatalog(tracks));
    await withTimeout(
      Promise.all([this.publishTrack(c.wt, 0, 'catalog', CATALOG_ALIAS), this.writeStream(c, encodeGroup(CATALOG_ALIAS, 0, catalog))]),
      timeout,
      'MoQ catalog PUBLISH',
    );
    const media = [this.publishTrack(c.wt, 2, '0', VIDEO_ALIAS)];
    if (tracks.audio) media.push(this.publishTrack(c.wt, 4, '1', AUDIO_ALIAS));
    await withTimeout(Promise.all(media), timeout, 'MoQ track PUBLISH');
  }

  /** PUBLISH on its own bidirectional stream, which stays open for the session. */
  private async publishTrack(wt: WebTransport, requestId: number, trackName: string, trackAlias: number) {
    const bidi = await wt.createBidirectionalStream();
    const writer = bidi.writable.getWriter();
    await writer.write(encodePublish({ requestId, namespace: NAMESPACE, trackName, trackAlias, authorization: this.authorization }));
    writer.releaseLock();
    const reader = new StreamReader(bidi.readable);
    const type = Number(await reader.readVarint());
    const payload = await reader.readBytes(await reader.readU16());
    if (type === MSG_REQUEST_ERROR) {
      const { reason } = decodeRequestError(payload);
      throw new RejectedError(`MoQ server refused track "${trackName}": ${reason || 'request error'}`);
    }
    if (type !== MSG_REQUEST_OK) throw new Error(`expected REQUEST_OK, got message 0x${type.toString(16)}`);
  }

  private send(c: Connection, alias: number, payload: Uint8Array, timestamp: number) {
    const groupId = c.groups.get(alias) ?? 0;
    c.groups.set(alias, groupId + 1);
    const bytes = encodeGroup(alias, groupId, payload, timestamp);
    // A failed stream means the session is going away; wt.closed handles that.
    this.writeStream(c, bytes).catch(() => {});
    this.bytesSent += bytes.length;
  }

  private async writeStream(c: Connection, bytes: Uint8Array) {
    c.pending += bytes.length;
    try {
      const writer = (await c.wt.createUnidirectionalStream()).getWriter();
      await writer.write(bytes);
      await writer.close();
    } finally {
      c.pending -= bytes.length;
    }
  }

  private async establish(): Promise<void> {
    const timeout = this.options.connectTimeoutMs ?? 5000;
    const hash = await withTimeout(this.fetchFingerprint(), timeout, 'MoQ certificate fingerprint');
    const options = {
      ...(hash ? { serverCertificateHashes: [{ algorithm: 'sha-256', value: hash }] } : {}),
      protocols: [MOQT_PROTOCOL],
    } as WebTransportOptions;
    const wt = new WebTransport(this.options.url, options);
    this.wt = wt;
    try {
      await withTimeout(wt.ready, timeout, 'MoQ WebTransport connection');
      await withTimeout(this.setup(wt), timeout, 'MoQ setup');
    } catch (err) {
      try {
        wt.close();
      } catch {
        // Not open.
      }
      throw err instanceof Error ? err : new Error(String(err));
    }

    const conn: Connection = { wt, pending: 0, state: 'setup', queue: [], groups: new Map(), needKeyframe: true };
    this.conn = conn;
    this.retryDelay = 1000;
    this.events.onOpen();
    wt.closed
      .catch(() => undefined)
      .then((info) => {
        if (this.conn !== conn) return;
        this.conn = undefined;
        if (this.closed) return;
        const reason = (info as WebTransportCloseInfo | undefined)?.reason || 'connection lost';
        this.events.onClose(`${reason}, reconnecting`);
        this.scheduleReconnect();
      });
  }

  private async setup(wt: WebTransport) {
    const writer = (await wt.createUnidirectionalStream()).getWriter();
    await writer.write(encodeClientSetup());
    writer.releaseLock();
    const incoming = wt.incomingUnidirectionalStreams.getReader();
    const { value, done } = await incoming.read();
    incoming.releaseLock();
    if (done || !value) throw new Error('MoQ server closed before SERVER_SETUP');
    const reader = new StreamReader(value);
    const type = Number(await reader.readVarint());
    if (type !== MSG_SETUP) throw new Error(`expected SERVER_SETUP, got message 0x${type.toString(16)}`);
    await reader.readBytes(await reader.readU16());
  }

  private async fetchFingerprint(): Promise<Uint8Array<ArrayBuffer> | undefined> {
    const { fingerprintUrl, url } = this.options;
    if (fingerprintUrl === false) return undefined;
    const target = fingerprintUrl ?? `${url.replace(/\/+$/, '')}/fingerprint`;
    // No credentials: MediaMTX serves the fingerprint to anyone, and an Authorization
    // header would need a CORS preflight that MediaMTX does not fully answer.
    let res: Response;
    try {
      res = await fetch(target);
    } catch (err) {
      // Browsers report every network failure the same way, so name the usual causes.
      throw new Error(
        `Could not fetch the MoQ certificate fingerprint from ${target} (${(err as Error).message}). ` +
          `Usually the browser does not trust the server's self-signed certificate: open ${new URL(target, globalThis.location?.href).origin}/ once and accept it, ` +
          `or serve the fingerprint from this page's origin (moqFingerprintUrl). Otherwise the server is unreachable or does not allow this origin (moqAllowOrigins).`,
      );
    }
    if (!res.ok) throw new Error(`MoQ certificate fingerprint: HTTP ${res.status} from ${target}`);
    return hexToBytes((await res.text()).trim());
  }

  /** The session failed mid-publish (not refused): close it and let the closed handler reconnect. */
  private drop(c: Connection) {
    try {
      c.wt.close({ closeCode: 0, reason: 'publish failed' });
    } catch {
      // Already closed.
    }
  }

  /** Refused by the server: retrying will not help. */
  private reject(reason: string) {
    this.close();
    this.events.onClose(reason);
  }

  private scheduleReconnect() {
    this.retryTimer = setTimeout(() => {
      if (this.closed) return;
      this.establish().catch((err) => {
        if (this.closed) return;
        if (err instanceof RejectedError) {
          this.reject(err.message);
          return;
        }
        this.scheduleReconnect();
      });
    }, this.retryDelay);
    this.retryDelay = Math.min(this.retryDelay * 2, 10_000);
  }
}

/** A SHA-256 fingerprint as hex ("ab12..."; colons allowed) -> bytes. */
export function hexToBytes(hex: string): Uint8Array<ArrayBuffer> {
  const clean = hex.replace(/:/g, '');
  if (!/^[0-9a-f]{64}$/i.test(clean)) throw new Error(`invalid certificate fingerprint "${hex.slice(0, 80)}"`);
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = parseInt(clean.slice(2 * i, 2 * i + 2), 16);
  return out;
}
