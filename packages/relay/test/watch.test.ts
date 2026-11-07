import { createSocket, type Socket } from 'node:dgram';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { startRelay } from '../src/server';
import { REPLACED_CLOSE_CODE } from '../src/streams';
import { UNKNOWN_DEVICE_CLOSE_CODE } from '../src/watch';

const cleanup: (() => void)[] = [];
afterEach(() => cleanup.splice(0).reverse().forEach((f) => f()));

const waitFor = async (cond: () => boolean, what = 'condition') => {
  for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setTimeout(r, 10));
  if (!cond()) throw new Error(`timed out waiting for ${what}`);
};

async function relay(adminToken?: string) {
  // A UDP sink so the relay's output port exists (sends to a closed port would be harmless anyway).
  const udp: Socket = createSocket('udp4');
  await new Promise<void>((r) => udp.bind(0, '127.0.0.1', r));
  const port = udp.address().port;
  const r = await startRelay({ port: 0, allow: ['127.0.0.1:*'], autoPorts: [port, port], adminToken });
  cleanup.push(() => udp.close(), () => r.close());
  return { r, ws: `ws://127.0.0.1:${r.port}` };
}

/** Opens a WebSocket and records what it receives. */
function client(url: string, headers?: Record<string, string>) {
  const ws = new WebSocket(url, { headers });
  const binary: Buffer[] = [];
  const status: boolean[] = [];
  let closeCode: number | undefined;
  ws.on('message', (data, isBinary) => {
    if (isBinary) binary.push(Buffer.from(data as Buffer));
    else status.push((JSON.parse(String(data)) as { connected: boolean }).connected);
  });
  ws.on('close', (code) => (closeCode = code));
  ws.on('error', () => {});
  cleanup.push(() => ws.terminate());
  const open = new Promise<void>((resolve, reject) => {
    ws.on('open', () => resolve());
    ws.on('close', (code) => reject(new Error(`closed ${code}`)));
  });
  return { ws, binary, status, open, closeCode: () => closeCode };
}

const packets = (n: number, fill: number) => Buffer.alloc(188 * n, fill).fill(0x47, 0, 1);

describe('/watch', () => {
  it('relays a device\'s datagrams and status to viewers, across reconnects', async () => {
    const { r, ws } = await relay();
    const device = client(`${ws}/relay?device=cam-1&name=Cam`); // ingest still accepts any path
    await device.open;

    const viewer = client(`${ws}/watch?device=cam-1`);
    await viewer.open;
    await waitFor(() => viewer.status.length === 1, 'initial status');
    expect(viewer.status).toEqual([true]);
    expect(r.registry.info('cam-1')?.viewers).toBe(1);

    const payload = packets(7 * 2 + 3, 0xaa);
    device.ws.send(payload);
    await waitFor(() => Buffer.concat(viewer.binary).length === payload.length, 'video data');
    expect(viewer.binary.map((b) => b.length)).toEqual([7 * 188, 7 * 188, 3 * 188]);
    expect(Buffer.concat(viewer.binary).equals(payload)).toBe(true);

    device.ws.close();
    await waitFor(() => viewer.status.length === 2, 'offline status');
    expect(viewer.status[1]).toBe(false);

    const again = client(`${ws}/?device=cam-1`);
    await again.open;
    await waitFor(() => viewer.status.length === 3, 'online status');
    again.ws.send(packets(1, 0xbb));
    await waitFor(() => viewer.binary.length === 4, 'data after reconnect');
    expect(viewer.binary[3][1]).toBe(0xbb);

    // A replaced connection hands over without the viewer seeing the device go offline.
    const replacement = client(`${ws}/?device=cam-1`);
    await replacement.open;
    await waitFor(() => again.closeCode() === REPLACED_CLOSE_CODE, 'replacement');
    expect(viewer.status.every((s, i) => i === 1 || s)).toBe(true);

    viewer.ws.close();
    await waitFor(() => r.registry.info('cam-1')?.viewers === 0, 'viewer count drop');
  });

  it('shows viewers in the /streams API', async () => {
    const { r, ws } = await relay();
    const device = client(`${ws}/?device=cam-2`);
    await device.open;
    const viewer = client(`${ws}/watch?device=cam-2`);
    await viewer.open;
    await waitFor(() => viewer.status.length > 0, 'status');
    const body = (await (await fetch(`http://127.0.0.1:${r.port}/streams/cam-2`)).json()) as { viewers: number };
    expect(body.viewers).toBe(1);
  });

  it('rejects unknown devices', async () => {
    const { ws } = await relay();
    const viewer = client(`${ws}/watch?device=nobody`);
    await viewer.open.catch(() => {});
    await waitFor(() => viewer.closeCode() !== undefined, 'close');
    expect(viewer.closeCode()).toBe(UNKNOWN_DEVICE_CLOSE_CODE);
  });

  it('requires the admin token when one is configured', async () => {
    const { ws } = await relay('s3cret');
    const device = client(`${ws}/?device=cam-3`);
    await device.open;

    for (const url of [`${ws}/watch?device=cam-3`, `${ws}/watch?device=cam-3&token=wrong`]) {
      const viewer = client(url);
      await viewer.open.catch(() => {});
      await waitFor(() => viewer.closeCode() !== undefined, 'close');
      expect(viewer.closeCode()).toBe(1008);
    }

    const byQuery = client(`${ws}/watch?device=cam-3&token=s3cret`);
    await byQuery.open;
    await waitFor(() => byQuery.status.length > 0, 'status');
    const byHeader = client(`${ws}/watch?device=cam-3`, { authorization: 'Bearer s3cret' });
    await byHeader.open;
    await waitFor(() => byHeader.status.length > 0, 'status');
    expect(byQuery.status).toEqual([true]);
    expect(byHeader.status).toEqual([true]);
  });

  it('closes viewers when their device is forgotten', async () => {
    const { r, ws } = await relay();
    const device = client(`${ws}/?device=cam-4`);
    await device.open;
    device.ws.close();
    await waitFor(() => r.registry.info('cam-4')?.connected === false, 'disconnect');

    const viewer = client(`${ws}/watch?device=cam-4`);
    await viewer.open;
    await waitFor(() => viewer.status.length > 0, 'status');
    expect(viewer.status).toEqual([false]);
    r.registry.forget('cam-4');
    await waitFor(() => viewer.closeCode() !== undefined, 'close');
    expect(viewer.closeCode()).toBe(UNKNOWN_DEVICE_CLOSE_CODE);
  });
});
