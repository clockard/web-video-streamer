import { afterEach, describe, expect, it, vi } from 'vitest';
import { decodeVarint, encodeTuple, encodeVarint } from '../src/moq/varint';
import { authorizationValue, decodeRequestError, encodeClientSetup, encodePublish } from '../src/moq/messages';
import { AvcPackager, encodeGroup } from '../src/moq/loc';
import { avc3Codec, buildCatalog } from '../src/moq/catalog';
import { hexToBytes, MoqPublisher } from '../src/moq/publisher';

/*
 * Golden bytes were captured by running MediaMTX v1.21.3's own browser publisher
 * (internal/servers/moq/publisher.js) against a fake WebTransport. One deliberate
 * difference: that publisher spells the namespace "stream" as six one-letter
 * fields; we send the single field the spec intends (MediaMTX ignores it).
 */
const hex = (u: Uint8Array) => Buffer.from(u).toString('hex');
const bytes = (h: string) => new Uint8Array(Buffer.from(h.replace(/\s/g, ''), 'hex'));
const NS_STREAM = hex(encodeTuple(['stream'])); // 01 06 "stream"
const AUTH_ABC = '01030c030042656172657220616263'; // AUTHORIZATION TOKEN "Bearer abc"

const SPS = [0x67, 0x64, 0x00, 0x1f, 0xac];
const PPS = [0x68, 0xee, 0x3c, 0x80];
const IDR = [0x65, 0x88, 0x84, 0x00];
const annexB = (...nals: number[][]) => new Uint8Array(nals.flatMap((n) => [0, 0, 0, 1, ...n]));

describe('draft-22 varint', () => {
  const cases: [bigint, string][] = [
    [0n, '00'],
    [127n, '7f'],
    [128n, '8080'],
    [0x2f00n, 'af00'],
    [16383n, 'bfff'],
    [16384n, 'c04000'],
    [90000n, 'c15f90'],
    [2n ** 21n, 'e0200000'],
    [2n ** 28n, 'f010000000'],
    [2n ** 35n, 'f80800000000'],
    [2n ** 42n, 'fc040000000000'],
    [2n ** 49n, 'fe02000000000000'],
    [2n ** 56n, 'ff0100000000000000'],
    [2n ** 64n - 1n, 'ffffffffffffffffff'],
  ];
  it.each(cases)('encodes and decodes %s', (value, expected) => {
    expect(hex(encodeVarint(value))).toBe(expected);
    expect(decodeVarint(bytes(expected))).toEqual({ value, size: expected.length / 2 });
  });

  it('round-trips both sides of every length boundary', () => {
    for (let n = 1; n <= 9; n++) {
      const limit = n === 9 ? 2n ** 64n : 1n << BigInt(7 * n);
      for (const v of [limit - 1n, limit / 2n]) {
        const enc = encodeVarint(v);
        expect(enc.length).toBe(n);
        expect(decodeVarint(enc).value).toBe(v);
      }
    }
  });

  it('rejects negative and oversized values', () => {
    expect(() => encodeVarint(-1)).toThrow(RangeError);
    expect(() => encodeVarint(2n ** 64n)).toThrow(RangeError);
  });
});

describe('MOQT messages', () => {
  it('CLIENT_SETUP has no parameters', () => {
    expect(hex(encodeClientSetup())).toBe('af000000');
  });

  it('PUBLISH matches the MediaMTX publisher', () => {
    const catalog = encodePublish({ requestId: 0, namespace: ['stream'], trackName: 'catalog', trackAlias: 0, authorization: 'Bearer abc' });
    const payload = `00${NS_STREAM}07636174616c6f6700${AUTH_ABC}`;
    expect(hex(catalog)).toBe(`1d${(payload.length / 2).toString(16).padStart(4, '0')}${payload}`);

    const video = encodePublish({ requestId: 2, namespace: ['stream'], trackName: '0', trackAlias: 1, authorization: 'Bearer abc' });
    expect(hex(video)).toContain(`02${NS_STREAM}013001${AUTH_ABC}`);
  });

  it('PUBLISH without credentials sends no parameters', () => {
    // ... track name "1", alias 2, then a parameter count of 0.
    expect(hex(encodePublish({ requestId: 4, namespace: ['stream'], trackName: '1', trackAlias: 2 }))).toMatch(/01310200$/);
  });

  it('builds the Authorization value from credentials', () => {
    expect(authorizationValue({ token: 'abc' })).toBe('Bearer abc');
    expect(authorizationValue({ user: 'u', pass: 'p' })).toBe(`Basic ${btoa('u:p')}`);
    expect(authorizationValue({ user: '', pass: '' })).toBeUndefined();
    expect(authorizationValue()).toBeUndefined();
  });

  it('decodes REQUEST_ERROR', () => {
    const reason = new TextEncoder().encode('no one is publishing');
    const payload = new Uint8Array([0x02, 0x00, reason.length, ...reason]);
    expect(decodeRequestError(payload)).toEqual({ code: 2, retryIntervalMs: 0, reason: 'no one is publishing' });
  });
});

describe('LOC groups', () => {
  it('video group matches the MediaMTX publisher', () => {
    const payload = new AvcPackager().pack(annexB(SPS, PPS, IDR), true);
    expect(hex(encodeGroup(1, 0, payload, 90_000))).toBe('310100000406c15f9019000000056764001fac0000000468ee3c80000000046588840000000003');
  });

  it('audio group matches the MediaMTX publisher', () => {
    expect(hex(encodeGroup(2, 0, new Uint8Array([0x21, 0x10, 0x05]), 960))).toBe('31020000030683c00321100500000003');
  });

  it('catalog group has no properties', () => {
    const json = buildCatalog({ video: { codec: 'avc3.64001F' }, audio: { codec: 'opus', sampleRate: 48000, channels: 1 } });
    const payload = new TextEncoder().encode(json);
    expect(hex(encodeGroup(0, 0, payload))).toBe(`30000000${hex(encodeVarint(payload.length))}${hex(payload)}000003`);
  });
});

describe('catalog', () => {
  it('matches the MediaMTX publisher', () => {
    expect(JSON.parse(buildCatalog({ video: { codec: 'avc3.64001F' }, audio: { codec: 'opus', sampleRate: 48000, channels: 1 } }))).toEqual({
      version: 1,
      tracks: [
        { name: '0', packaging: 'loc', isLive: true, codec: 'avc3.64001F', clockrate: 90000 },
        { name: '1', packaging: 'loc', isLive: true, codec: 'opus', clockrate: 48000, samplerate: 48000, channels: 1 },
      ],
    });
  });

  it('can be video only', () => {
    expect(JSON.parse(buildCatalog({ video: { codec: 'avc3.42E01F' } })).tracks).toHaveLength(1);
  });

  it('signals in-band parameter sets', () => {
    expect(avc3Codec('avc1.64001F')).toBe('avc3.64001F');
  });
});

describe('AvcPackager', () => {
  const lengths = (u: Uint8Array) => {
    const out: number[] = [];
    for (let i = 0; i < u.length; ) {
      const n = new DataView(u.buffer, u.byteOffset).getUint32(i);
      out.push(u[i + 4] & 0x1f);
      i += 4 + n;
    }
    return out;
  };

  it('drops access unit delimiters and handles 3-byte start codes', () => {
    const data = new Uint8Array([0, 0, 1, 0x09, 0xf0, 0, 0, 1, ...SPS, 0, 0, 0, 1, ...PPS, 0, 0, 1, ...IDR]);
    expect(lengths(new AvcPackager().pack(data, true))).toEqual([7, 8, 5]);
  });

  it('adds the last SPS/PPS to keyframes that lack them', () => {
    const p = new AvcPackager();
    p.pack(annexB(SPS, PPS, IDR), true);
    expect(lengths(p.pack(annexB(IDR), true))).toEqual([7, 8, 5]);
    expect(lengths(p.pack(annexB([0x41, 0x9a]), false))).toEqual([1]);
  });
});

describe('hexToBytes', () => {
  it('parses MediaMTX fingerprints', () => {
    expect(hex(hexToBytes(`${'00'.repeat(31)}ff`))).toBe(`${'00'.repeat(31)}ff`);
    expect(hexToBytes(Array(32).fill('AB').join(':'))[0]).toBe(0xab);
    expect(() => hexToBytes('<html>')).toThrow(/invalid certificate fingerprint/);
  });
});

/** Just enough WebTransport for MoqPublisher; records what is written to each stream. */
class FakeWebTransport {
  static last: FakeWebTransport;
  static replies: number[][] = [];
  readonly uni: number[][] = [];
  readonly bidi: number[][] = [];
  readonly ready = Promise.resolve();
  readonly closed: Promise<WebTransportCloseInfo>;
  readonly incomingUnidirectionalStreams = new ReadableStream({
    start: (c) => c.enqueue(readable([0xaf, 0x00, 0x00, 0x00])),
  });
  closeCalls = 0;
  private resolveClosed!: (info: WebTransportCloseInfo) => void;

  constructor(
    readonly url: string,
    readonly options: { protocols?: string[]; serverCertificateHashes?: { value: Uint8Array }[] },
  ) {
    FakeWebTransport.last = this;
    this.closed = new Promise((r) => (this.resolveClosed = r));
  }

  async createUnidirectionalStream() {
    const out: number[] = [];
    this.uni.push(out);
    return new WritableStream<Uint8Array>({ write: (c) => void out.push(...c) });
  }

  async createBidirectionalStream() {
    const out: number[] = [];
    this.bidi.push(out);
    return { writable: new WritableStream<Uint8Array>({ write: (c) => void out.push(...c) }), readable: readable(FakeWebTransport.replies.shift() ?? [0x07, 0x00, 0x00]) };
  }

  close() {
    this.closeCalls++;
  }

  /** The server went away. */
  drop(reason = 'gone') {
    this.resolveClosed({ closeCode: 0, reason });
  }
}

function readable(data: number[]) {
  return new ReadableStream<Uint8Array>({ start: (c) => c.enqueue(new Uint8Array(data)) });
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('MoqPublisher', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    FakeWebTransport.replies = [];
  });

  const setup = (tracks = { video: { codec: 'avc3.64001F' }, audio: { codec: 'opus' as const, sampleRate: 48000, channels: 1 } }) => {
    const fetch = vi.fn(async () => ({ ok: true, status: 200, text: async () => `${'00'.repeat(31)}ff\n` }));
    vi.stubGlobal('fetch', fetch);
    vi.stubGlobal('WebTransport', FakeWebTransport);
    const events = { onOpen: vi.fn(), onClose: vi.fn() };
    const publisher = new MoqPublisher({ url: 'https://mtx:8892/phone/', credentials: { token: 'abc' }, tracks: () => tracks }, events);
    return { publisher, events, fetch };
  };

  it('pins the fetched fingerprint, negotiates moqt-22 and sends CLIENT_SETUP', async () => {
    const { publisher, events, fetch } = setup();
    await publisher.connect();
    expect(fetch).toHaveBeenCalledWith('https://mtx:8892/phone/fingerprint');
    const wt = FakeWebTransport.last;
    expect(wt.options.protocols).toEqual(['moqt-22']);
    expect(hex(wt.options.serverCertificateHashes![0].value)).toBe(`${'00'.repeat(31)}ff`);
    expect(hex(new Uint8Array(wt.uni[0]))).toBe('af000000');
    expect(events.onOpen).toHaveBeenCalledOnce();
    expect(publisher.connected).toBe(true);
  });

  it('publishes at the first keyframe, then sends queued frames as groups', async () => {
    const { publisher } = setup();
    await publisher.connect();
    const wt = FakeWebTransport.last;

    publisher.writeVideo(annexB([0x41, 0x9a]), 0, false); // before any keyframe: dropped
    publisher.writeAudio(new Uint8Array([1]), 0); // before publishing: dropped
    publisher.writeVideo(annexB(SPS, PPS, IDR), 1_000_000, true);
    publisher.writeAudio(new Uint8Array([0x21, 0x10, 0x05]), 20_000);
    expect(wt.bidi.length).toBeLessThanOrEqual(1);
    for (let i = 0; i < 10; i++) await tick();

    expect(wt.bidi.map((b) => hex(new Uint8Array(b)))).toEqual([
      expect.stringContaining(`07636174616c6f6700${AUTH_ABC}`),
      expect.stringContaining(`013001${AUTH_ABC}`),
      expect.stringContaining(`013102${AUTH_ABC}`),
    ]);
    const groups = wt.uni.slice(1).map((u) => hex(new Uint8Array(u)));
    expect(groups[0]).toMatch(/^30000000/); // catalog
    expect(groups).toContain('310100000406c15f9019000000056764001fac0000000468ee3c80000000046588840000000003');
    expect(groups).toContain('31020000030683c00321100500000003');
    expect(groups).toHaveLength(3);
    expect(publisher.bufferedAmount).toBe(0);
    expect(publisher.bytesSent).toBeGreaterThan(0);

    // Later frames go out directly, with increasing group IDs.
    publisher.writeVideo(annexB([0x41, 0x9a]), 1_033_333, false);
    await tick();
    expect(hex(new Uint8Array(wt.uni.at(-1)!))).toMatch(/^310101/);
  });

  it('stops without retrying when the server refuses the track', async () => {
    vi.useFakeTimers();
    const { publisher, events } = setup();
    await publisher.connect();
    const reason = [...new TextEncoder().encode('auth failed')];
    FakeWebTransport.replies = [[0x05, 0x00, 3 + reason.length, 0x01, 0x00, reason.length, ...reason]];
    const created = vi.spyOn(globalThis, 'WebTransport' as never);
    publisher.writeVideo(annexB(SPS, PPS, IDR), 0, true);
    await vi.runAllTimersAsync();
    expect(events.onClose).toHaveBeenCalledWith('MoQ server refused track "catalog": auth failed');
    expect(publisher.connected).toBe(false);
    expect(created).not.toHaveBeenCalled();
  });

  it('reconnects after the session drops and waits for a keyframe again', async () => {
    vi.useFakeTimers();
    const { publisher, events } = setup();
    await publisher.connect();
    const first = FakeWebTransport.last;
    publisher.writeVideo(annexB(SPS, PPS, IDR), 0, true);
    await vi.advanceTimersByTimeAsync(0);

    first.drop('server restart');
    await vi.advanceTimersByTimeAsync(0);
    expect(events.onClose).toHaveBeenCalledWith('server restart, reconnecting');
    expect(publisher.connected).toBe(false);

    await vi.advanceTimersByTimeAsync(1000);
    const second = FakeWebTransport.last;
    expect(second).not.toBe(first);
    expect(events.onOpen).toHaveBeenCalledTimes(2);

    publisher.writeVideo(annexB([0x41, 0x9a]), 33_333, false); // not a keyframe: still waiting
    await vi.advanceTimersByTimeAsync(0);
    expect(second.bidi).toHaveLength(0);
    publisher.writeVideo(annexB(IDR), 66_666, true); // SPS/PPS are re-added from the cache
    await vi.advanceTimersByTimeAsync(0);
    expect(second.bidi).toHaveLength(3);
    expect(second.uni.slice(1).map((u) => hex(new Uint8Array(u)))).toContainEqual(expect.stringMatching(/^310100.*6764001fac/));
  });

  it('explains a fingerprint fetch the browser blocked', async () => {
    const { publisher } = setup();
    vi.stubGlobal('location', { href: 'https://demo:5173/' });
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('Failed to fetch');
    });
    await expect(publisher.connect()).rejects.toThrow(/Failed to fetch\).*open https:\/\/mtx:8892\/ once and accept it/);
  });

  it('skips pinning when fingerprintUrl is false', async () => {
    vi.stubGlobal('WebTransport', FakeWebTransport);
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    await new MoqPublisher({ url: 'https://mtx.example.com/p', fingerprintUrl: false, tracks: () => undefined }, { onOpen() {}, onClose() {} }).connect();
    expect(fetch).not.toHaveBeenCalled();
    expect(FakeWebTransport.last.options.serverCertificateHashes).toBeUndefined();
  });
});
