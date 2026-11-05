import { createSocket } from 'node:dgram';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket, type WebSocketServer } from 'ws';
import { createRelay, DATAGRAM_SIZE, isAllowed, parseTarget } from '../src/relay';
import { StreamRegistry } from '../src/streams';

describe('parseTarget / isAllowed', () => {
  it('parses udp URLs and bare host:port', () => {
    expect(parseTarget('udp://10.0.0.5:5000')).toEqual({ host: '10.0.0.5', port: 5000 });
    expect(parseTarget('127.0.0.1:1234')).toEqual({ host: '127.0.0.1', port: 1234 });
    expect(() => parseTarget('http://x:1')).toThrow();
    expect(() => parseTarget('udp://x')).toThrow();
  });

  it('matches allow rules', () => {
    const t = { host: '10.0.0.5', port: 5000 };
    expect(isAllowed(t, ['10.0.0.5:5000'])).toBe(true);
    expect(isAllowed(t, ['10.0.0.5:*'])).toBe(true);
    expect(isAllowed(t, ['*'])).toBe(true);
    expect(isAllowed(t, ['10.0.0.5:5001', '10.0.0.6:*'])).toBe(false);
  });
});

describe('createRelay', () => {
  let wss: WebSocketServer | undefined;
  let registry: StreamRegistry | undefined;
  afterEach(() => {
    wss?.close();
    registry?.close();
  });

  const listening = (server: WebSocketServer) =>
    new Promise<number>((resolve) => server.on('listening', () => resolve((server.address() as AddressInfo).port)));

  it('forwards binary messages as 1316-byte UDP datagrams to the device\'s output', async () => {
    const udp = createSocket('udp4');
    await new Promise<void>((r) => udp.bind(0, '127.0.0.1', r));
    const udpPort = udp.address().port;
    const received: Buffer[] = [];
    const done = new Promise<void>((resolve) =>
      udp.on('message', (msg) => {
        received.push(msg);
        if (received.length === 3) resolve();
      }),
    );

    registry = new StreamRegistry({ allow: ['127.0.0.1:*'], autoPorts: [udpPort, udpPort] });
    wss = createRelay({ port: 0, registry });
    const port = await listening(wss);
    const ws = new WebSocket(`ws://127.0.0.1:${port}/?device=phone-1&name=Test`);
    await new Promise((r) => ws.on('open', r));
    const payload = Buffer.alloc(DATAGRAM_SIZE * 2 + 188, 0x47);
    ws.send(payload);
    await done;

    expect(received.map((b) => b.length)).toEqual([DATAGRAM_SIZE, DATAGRAM_SIZE, 188]);
    expect(registry.info('phone-1')).toMatchObject({ name: 'Test', connected: true, transport: 'websocket', peer: '127.0.0.1' });
    ws.close();
    udp.close();
  });

  it('rejects connections without a valid device id', async () => {
    registry = new StreamRegistry({ allow: ['127.0.0.1:*'] });
    wss = createRelay({ port: 0, registry });
    const port = await listening(wss);
    const ws = new WebSocket(`ws://127.0.0.1:${port}/?target=udp://8.8.8.8:53`);
    const code = await new Promise<number>((r) => ws.on('close', (c) => r(c)));
    expect(code).toBe(1008);
  });
});
