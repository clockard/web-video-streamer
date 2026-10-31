import { createSocket, type Socket } from 'node:dgram';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { startRelay } from '../src/server';
import { clientAddress, parsePortRange, REPLACED_CLOSE_CODE, StreamRegistry } from '../src/streams';

const registries: StreamRegistry[] = [];
const sockets: Socket[] = [];
afterEach(() => {
  registries.splice(0).forEach((r) => r.close());
  sockets.splice(0).forEach((s) => s.close());
});

function registry(options: Partial<ConstructorParameters<typeof StreamRegistry>[0]> = {}) {
  const r = new StreamRegistry({ allow: ['127.0.0.1:*'], ...options });
  registries.push(r);
  return r;
}

async function udpReceiver() {
  const socket = createSocket('udp4');
  sockets.push(socket);
  await new Promise<void>((r) => socket.bind(0, '127.0.0.1', r));
  const received: Buffer[] = [];
  socket.on('message', (m) => received.push(m));
  return { port: socket.address().port, received };
}

const waitFor = async (cond: () => boolean) => {
  for (let i = 0; i < 100 && !cond(); i++) await new Promise((r) => setTimeout(r, 10));
};

const attach = (r: StreamRegistry, deviceId: unknown, close: (code: number, reason: string) => void = () => {}) =>
  r.attach({ deviceId, transport: 'test', peer: '10.0.0.9', close });

describe('StreamRegistry', () => {
  it('auto-assigns the lowest free pool port, distinct per device and stable per device', () => {
    const r = registry({ autoPorts: [6000, 6002] });
    attach(r, 'a').detach();
    attach(r, 'b').detach();
    expect(r.info('a')?.target).toBe('udp://127.0.0.1:6000');
    expect(r.info('b')?.target).toBe('udp://127.0.0.1:6001');
    attach(r, 'a').detach();
    expect(r.info('a')?.target).toBe('udp://127.0.0.1:6000');
    r.forget('a');
    attach(r, 'c').detach();
    expect(r.info('c')).toMatchObject({ target: 'udp://127.0.0.1:6000', assigned: 'auto' });
    attach(r, 'd').detach();
    expect(() => attach(r, 'e')).toThrow(/no free output ports/);
  });

  it('rejects invalid device ids', () => {
    const r = registry();
    for (const id of [undefined, '', 'has space', 'x'.repeat(65), 42]) expect(() => attach(r, id)).toThrow(/device id/);
  });

  it('keeps mappings in the JSON file across restarts', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'wvs-')), 'mappings.json');
    const first = registry({ mappingsFile: file, autoPorts: [7000, 7010] });
    first.attach({ deviceId: 'phone', name: 'Phone', transport: 'test', close: () => {} }).detach();
    first.setTarget('tablet', 'udp://127.0.0.1:9000');
    expect(JSON.parse(readFileSync(file, 'utf8')).devices.phone.target).toBe('udp://127.0.0.1:7000');

    const second = registry({ mappingsFile: file, autoPorts: [7000, 7010] });
    expect(second.info('phone')).toMatchObject({ target: 'udp://127.0.0.1:7000', name: 'Phone', connected: false });
    expect(second.info('tablet')).toMatchObject({ target: 'udp://127.0.0.1:9000', assigned: 'manual' });
    attach(second, 'new').detach();
    expect(second.info('new')?.target).toBe('udp://127.0.0.1:7001');
  });

  it('enforces the allowlist when setting targets', () => {
    const r = registry({ allow: ['127.0.0.1:5000', '127.0.0.1:6000'] });
    expect(() => r.setTarget('a', 'udp://8.8.8.8:53')).toThrow(/not allowed/);
    expect(() => r.setTarget('a', 'http://x:1')).toThrow(/unsupported protocol/);
    expect(r.setTarget('a', '127.0.0.1:6000').target).toBe('udp://127.0.0.1:6000');
  });

  it('moves a live stream to a new target immediately', async () => {
    const one = await udpReceiver();
    const two = await udpReceiver();
    const r = registry({ autoPorts: [one.port, one.port] });
    const session = attach(r, 'cam');
    session.send(Buffer.alloc(188, 1));
    await waitFor(() => one.received.length === 1);
    r.setTarget('cam', `udp://127.0.0.1:${two.port}`);
    session.send(Buffer.alloc(188, 2));
    await waitFor(() => two.received.length === 1);
    expect(one.received).toHaveLength(1);
    expect(two.received[0][0]).toBe(2);
    expect(r.info('cam')).toMatchObject({ connected: true, assigned: 'manual', bytes: 376, peer: '10.0.0.9' });
  });

  it('closes the older connection when the same device connects again', async () => {
    const out = await udpReceiver();
    const r = registry({ autoPorts: [out.port, out.port] });
    const closes: [number, string][] = [];
    const first = attach(r, 'cam', (code, reason) => closes.push([code, reason]));
    const second = attach(r, 'cam');
    expect(closes).toEqual([[REPLACED_CLOSE_CODE, expect.stringMatching(/replaced/)]]);
    first.send(Buffer.alloc(188, 1)); // ignored: no longer the live session
    first.detach(); // must not end the new session
    second.send(Buffer.alloc(188, 2));
    await waitFor(() => out.received.length === 1);
    await new Promise((r) => setTimeout(r, 30));
    expect(out.received.map((b) => b[0])).toEqual([2]);
    expect(r.info('cam')?.connected).toBe(true);
    expect(() => r.forget('cam')).toThrow(/streaming/);
  });
});

describe('clientAddress', () => {
  it('trusts X-Forwarded-For only from loopback', () => {
    expect(clientAddress('::ffff:127.0.0.1', '192.168.1.20, 10.0.0.1')).toBe('192.168.1.20');
    expect(clientAddress('::1', '192.168.1.20')).toBe('192.168.1.20');
    expect(clientAddress('192.168.1.30', '1.2.3.4')).toBe('192.168.1.30');
    expect(clientAddress('::ffff:192.168.1.30', undefined)).toBe('192.168.1.30');
  });
});

describe('parsePortRange', () => {
  it('parses ranges and single ports', () => {
    expect(parsePortRange('5000-5099')).toEqual([5000, 5099]);
    expect(parsePortRange('5000')).toEqual([5000, 5000]);
    expect(() => parsePortRange('6000-5000')).toThrow();
  });
});

describe('/streams API', () => {
  async function relay(adminToken?: string) {
    const r = await startRelay({ port: 0, allow: ['127.0.0.1:*'], autoPorts: [8100, 8199], adminToken });
    registries.push(r.registry);
    const base = `http://127.0.0.1:${r.port}`;
    return { r, base };
  }

  it('lists, updates and forgets devices', async () => {
    const { r, base } = await relay();
    try {
      attach(r.registry, 'phone').detach();
      let res = await fetch(`${base}/streams`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { streams: { deviceId: string; target: string }[]; allow: string[] };
      expect(body.allow).toEqual(['127.0.0.1:*']);
      expect(body.streams).toMatchObject([{ deviceId: 'phone', target: 'udp://127.0.0.1:8100' }]);

      const put = (target: unknown) =>
        fetch(`${base}/streams/phone`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ target }) });
      res = await put('udp://127.0.0.1:9999');
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ deviceId: 'phone', target: 'udp://127.0.0.1:9999', assigned: 'manual' });
      expect((await put('udp://8.8.8.8:53')).status).toBe(403);
      expect((await put('nonsense://')).status).toBe(400);
      expect((await fetch(`${base}/streams/phone`, { method: 'PUT', body: 'not json' })).status).toBe(400);

      expect((await fetch(`${base}/streams/phone`, { method: 'DELETE' })).status).toBe(204);
      expect((await fetch(`${base}/streams/phone`)).status).toBe(404);
      expect((await fetch(`${base}/streams/phone`, { method: 'DELETE' })).status).toBe(404);
    } finally {
      r.close();
    }
  });

  it('requires the admin token when one is configured', async () => {
    const { r, base } = await relay('s3cret');
    try {
      expect((await fetch(`${base}/streams`)).status).toBe(401);
      expect((await fetch(`${base}/streams`, { headers: { authorization: 'Bearer wrong' } })).status).toBe(401);
      expect((await fetch(`${base}/streams`, { headers: { authorization: 'Bearer s3cret' } })).status).toBe(200);
      const preflight = await fetch(`${base}/streams/x`, { method: 'OPTIONS' });
      expect(preflight.status).toBe(204);
      expect(preflight.headers.get('access-control-allow-headers')).toContain('authorization');
    } finally {
      r.close();
    }
  });
});
