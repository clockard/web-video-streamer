import { describe, expect, it } from 'vitest';
import { AudioPesBuffer, AudioTimestamper, remixPlanes, type EncodedAudio } from '../src/audio';
import { StreamClock } from '../src/clock';
import { adtsHeader, opusControlHeader, parseAudioSpecificConfig, sampleRateIndex, toAdts, toOpusTs } from '../src/ts/audio';

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');

describe('ADTS', () => {
  it('builds a 7-byte header for AAC-LC 48 kHz mono', () => {
    // frame length 107 = 100 + 7
    expect(hex(adtsHeader({ objectType: 2, sampleRateIndex: 3, channels: 1 }, 100))).toBe('fff14c400d7ffc');
  });

  it('encodes stereo 44.1 kHz and long frames', () => {
    const h = adtsHeader({ objectType: 2, sampleRateIndex: sampleRateIndex(44100), channels: 2 }, 2000);
    const frameLength = ((h[3] & 0x03) << 11) | (h[4] << 3) | (h[5] >> 5);
    expect(frameLength).toBe(2007);
    expect((h[2] >> 2) & 0x0f).toBe(4);
    expect(((h[2] & 1) << 2) | (h[3] >> 6)).toBe(2);
    expect(() => adtsHeader({ objectType: 2, sampleRateIndex: 3, channels: 1 }, 0x2000)).toThrow(RangeError);
  });

  it('prefixes raw frames', () => {
    const out = toAdts({ objectType: 2, sampleRateIndex: 3, channels: 1 }, new Uint8Array([1, 2, 3]));
    expect(out.length).toBe(10);
    expect(hex(out.subarray(7))).toBe('010203');
  });

  it('parses an AudioSpecificConfig', () => {
    // AAC-LC, 48 kHz, mono: 00010 0011 0001 000
    expect(parseAudioSpecificConfig(new Uint8Array([0x11, 0x88]))).toEqual({ objectType: 2, sampleRateIndex: 3, channels: 1 });
    expect(parseAudioSpecificConfig(new Uint8Array([0x12, 0x10]))).toEqual({ objectType: 2, sampleRateIndex: 4, channels: 2 });
    expect(parseAudioSpecificConfig(new Uint8Array([0x17]))).toBeUndefined();
  });
});

describe('Opus control header', () => {
  it('encodes au_size as a run of 0xFF bytes plus a remainder', () => {
    expect(hex(opusControlHeader(100))).toBe('7fe064');
    expect(hex(opusControlHeader(254))).toBe('7fe0fe');
    expect(hex(opusControlHeader(255))).toBe('7fe0ff00');
    expect(hex(opusControlHeader(510))).toBe('7fe0ffff00');
    expect(hex(opusControlHeader(600))).toBe('7fe0ffff5a');
  });

  it('prefixes packets', () => {
    expect(hex(toOpusTs(new Uint8Array([9, 8])))).toBe('7fe00209' + '08');
  });
});

describe('AudioTimestamper', () => {
  it('counts samples instead of following arrival jitter', () => {
    let now = 0;
    const t = new AudioTimestamper(() => now);
    const stamps: number[] = [];
    // 1024-sample blocks at 48 kHz (21.333 ms) arriving with ±5 ms jitter.
    for (let i = 1; i <= 10; i++) {
      now = (i * 1024 * 1e6) / 48000 + (i % 2 ? 5000 : -5000);
      stamps.push(t.stamp(1024, 48000));
    }
    const first = stamps[0];
    stamps.forEach((s, i) => expect(s).toBe(Math.round(first + (i * 1024 * 1e6) / 48000)));
  });

  it('re-anchors to the clock after a stall', () => {
    let now = 21_333;
    const t = new AudioTimestamper(() => now);
    expect(t.stamp(1024, 48000)).toBe(0);
    now = 2_000_000; // nothing arrived for two seconds
    expect(t.stamp(1024, 48000)).toBe(Math.round(2_000_000 - 21_333.33));
  });

  it('works with the stream clock', () => {
    let ms = 1000;
    const clock = new StreamClock(() => ms);
    ms = 1050;
    expect(clock.nowUs()).toBe(50_000);
    expect(new AudioTimestamper(() => clock.nowUs()).stamp(480, 48000)).toBe(40_000);
  });
});

describe('AudioPesBuffer', () => {
  const frame = (i: number, durationUs = 20_000): EncodedAudio => ({ data: new Uint8Array([i]), timestampUs: i * durationUs, durationUs });

  it('groups ~100 ms of frames per PES with the first PTS', () => {
    const out: [number[], number][] = [];
    const buf = new AudioPesBuffer((frames, ts) => out.push([frames.map((f) => f[0]), ts]));
    for (let i = 0; i < 12; i++) buf.push(frame(i));
    expect(out).toEqual([
      [[0, 1, 2, 3, 4], 0],
      [[5, 6, 7, 8, 9], 100_000],
    ]);
    buf.flush();
    expect(out[2]).toEqual([[10, 11], 200_000]);
  });

  it('starts a new PES at a timestamp gap', () => {
    const out: number[] = [];
    const buf = new AudioPesBuffer((_, ts) => out.push(ts));
    buf.push(frame(0));
    buf.push(frame(1));
    buf.push(frame(10)); // gap
    buf.flush();
    expect(out).toEqual([0, 200_000]);
  });
});

describe('remixPlanes', () => {
  it('averages to mono and duplicates to stereo', () => {
    const [mono] = remixPlanes([new Float32Array([1, 0]), new Float32Array([0, 1])], 1);
    expect([...mono]).toEqual([0.5, 0.5]);
    const stereo = remixPlanes([new Float32Array([0.25])], 2);
    expect(stereo.map((p) => p[0])).toEqual([0.25, 0.25]);
  });
});
