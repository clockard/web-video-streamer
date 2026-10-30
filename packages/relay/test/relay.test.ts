import { createSocket } from 'node:dgram';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket, type WebSocketServer } from 'ws';
import { createRelay, DATAGRAM_SIZE, isAllowed, parseTarget } from '../src/relay';

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
  afterEach(() => wss?.close());

  const listening = (server: WebSocketServer) =>
    new Promise<number>((resolve) => server.on('listening', () => resolve((server.address() as AddressInfo).port)));

  it('forwards binary messages as 1316-byte UDP datagrams', async () => {
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

    wss = createRelay({ port: 0, allow: ['127.0.0.1:*'] });
    const port = await listening(wss);
    const ws = new WebSocket(`ws://127.0.0.1:${port}/?target=udp://127.0.0.1:${udpPort}`);
    await new Promise((r) => ws.on('open', r));
    const payload = Buffer.alloc(DATAGRAM_SIZE * 2 + 188, 0x47);
    ws.send(payload);
    await done;

    expect(received.map((b) => b.length)).toEqual([DATAGRAM_SIZE, DATAGRAM_SIZE, 188]);
    ws.close();
    udp.close();
  });

  it('rejects targets that are not allowed', async () => {
    wss = createRelay({ port: 0, allow: ['127.0.0.1:5000'] });
    const port = await listening(wss);
    const ws = new WebSocket(`ws://127.0.0.1:${port}/?target=udp://8.8.8.8:53`);
    const code = await new Promise<number>((r) => ws.on('close', (c) => r(c)));
    expect(code).toBe(1008);
  });
});
