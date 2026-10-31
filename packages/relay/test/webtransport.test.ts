import { createSocket } from 'node:dgram';
import { lookup } from 'node:dns/promises';
import { X509Certificate } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebTransport, quicheLoaded } from '@fails-components/webtransport';
import { generateSelfSignedCertificate, SELF_SIGNED_VALIDITY_DAYS, type ServerCertificate } from '../src/cert';
import { TsDatagramChunker } from '../src/relay';
import { StreamRegistry } from '../src/streams';
import { createWebTransportRelay, WEBTRANSPORT_PATH } from '../src/webtransport';

describe('generateSelfSignedCertificate', () => {
  it('creates a short-lived ECDSA certificate whose hash matches its DER', async () => {
    const c = await generateSelfSignedCertificate(['localhost', '127.0.0.1']);
    const x = new X509Certificate(c.cert);
    expect(x.publicKey.asymmetricKeyType).toBe('ec');
    const days = (Date.parse(x.validTo) - Date.parse(x.validFrom)) / 86_400_000;
    expect(days).toBeLessThanOrEqual(14);
    expect(days).toBeCloseTo(SELF_SIGNED_VALIDITY_DAYS, 0);
    expect(x.subjectAltName).toContain('IP Address:127.0.0.1');
    expect(Buffer.from(c.sha256, 'base64').toString('hex')).toBe(x.fingerprint256.replace(/:/g, '').toLowerCase());
  });
});

describe('TsDatagramChunker', () => {
  it('emits whole TS packets only and holds back partial ones', () => {
    const out: number[] = [];
    const chunker = new TsDatagramChunker((d) => out.push(d.length));
    chunker.push(new Uint8Array(1316 + 188 + 100));
    expect(out).toEqual([1316, 188]);
    chunker.push(new Uint8Array(88));
    expect(out).toEqual([1316, 188, 188]);
  });
});

describe('WebTransport relay', () => {
  let cert: ServerCertificate;
  let relay: Awaited<ReturnType<typeof createWebTransportRelay>>;
  let registry: StreamRegistry;
  let url: string;
  const udp = createSocket('udp4');
  const received: Buffer[] = [];

  beforeAll(async () => {
    await quicheLoaded;
    cert = await generateSelfSignedCertificate(['127.0.0.1']);
    await new Promise<void>((r) => udp.bind(0, '127.0.0.1', r));
    udp.on('message', (m) => received.push(m));
    registry = new StreamRegistry({ allow: ['127.0.0.1:*'] });
    relay = await createWebTransportRelay({ port: 0, host: '127.0.0.1', cert: cert.cert, privateKey: cert.privateKey, registry });
    url = `https://127.0.0.1:${relay.address()!.port}${WEBTRANSPORT_PATH}`;
  });

  afterAll(() => {
    relay?.close();
    registry?.close();
    udp.close();
  });

  async function open(device: unknown, mode: 'datagram' | 'stream', to = url) {
    const wt = new WebTransport(to, {
      serverCertificateHashes: [{ algorithm: 'sha-256', value: Buffer.from(cert.sha256, 'base64') }],
    });
    await wt.ready;
    const control = await wt.createBidirectionalStream();
    const writer = control.writable.getWriter();
    await writer.write(new TextEncoder().encode(`${JSON.stringify({ device, mode })}\n`));
    const { value } = await control.readable.getReader().read();
    return { wt, reply: JSON.parse(new TextDecoder().decode(value)) as { ok?: boolean; error?: string } };
  }

  const waitFor = async (cond: () => boolean) => {
    for (let i = 0; i < 100 && !cond(); i++) await new Promise((r) => setTimeout(r, 20));
  };

  it('forwards datagrams as UDP datagrams', async () => {
    received.length = 0;
    registry.setTarget('wt-datagram', `udp://127.0.0.1:${udp.address().port}`);
    const { wt, reply } = await open('wt-datagram', 'datagram');
    expect(reply).toEqual({ ok: true });
    const writer = wt.datagrams.writable.getWriter();
    for (let i = 0; i < 3; i++) await writer.write(new Uint8Array(6 * 188).fill(0x47));
    await waitFor(() => received.length >= 3);
    expect(received.map((d) => d.length)).toEqual([1128, 1128, 1128]);
    expect(registry.info('wt-datagram')).toMatchObject({ connected: true, transport: 'webtransport/datagram', peer: '127.0.0.1' });
    wt.close();
  });

  it('re-chunks stream data into TS-aligned datagrams', async () => {
    received.length = 0;
    registry.setTarget('wt-stream', `udp://127.0.0.1:${udp.address().port}`);
    const { wt, reply } = await open('wt-stream', 'stream');
    expect(reply).toEqual({ ok: true });
    const stream = await wt.createUnidirectionalStream();
    const writer = stream.getWriter();
    await writer.write(new Uint8Array(10 * 188).fill(0x47));
    await waitFor(() => received.reduce((n, d) => n + d.length, 0) >= 10 * 188);
    // Stream reads arrive in arbitrary sizes; whole packets are sent as soon as they arrive.
    expect(received.reduce((n, d) => n + d.length, 0)).toBe(10 * 188);
    for (const d of received) {
      expect(d.length % 188).toBe(0);
      expect(d.length).toBeLessThanOrEqual(1316);
    }
    wt.close();
  });

  it('accepts IPv4 and IPv6 clients on the default dual-stack address', async () => {
    const dual = await createWebTransportRelay({ port: 0, cert: cert.cert, privateKey: cert.privateKey, registry });
    try {
      const port = dual.address()!.port;
      registry.setTarget('dual-v4', `udp://127.0.0.1:${udp.address().port}`);
      registry.setTarget('dual-v6', `udp://127.0.0.1:${udp.address().port}`);
      // The Node client cannot connect to a bracketed IPv6 literal, so use the hosts-file name for ::1.
      const v6 = await lookup('ip6-localhost', { family: 6 }).then(() => 'ip6-localhost', () => undefined);
      for (const [host, device, peer] of [['127.0.0.1', 'dual-v4', '127.0.0.1'], ...(v6 ? [[v6, 'dual-v6', '::1']] : [])]) {
        const { wt, reply } = await open(device, 'datagram', `https://${host}:${port}${WEBTRANSPORT_PATH}`);
        expect(reply).toEqual({ ok: true });
        expect(registry.info(device)?.peer).toBe(peer);
        wt.close();
      }
    } finally {
      dual.close();
    }
  });

  it('rejects sessions without a valid device id', async () => {
    const { wt, reply } = await open('bad id!', 'datagram');
    expect(reply.error).toMatch(/device id/);
    await wt.closed.catch(() => {});
  });
});
