import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import misb from '@vidterra/misb.js';
import { encodeSt0601 } from '../src/klv/st0601';
import { crc32Mpeg } from '../src/ts/crc32';
import { PID, splitNalUnits, TS_PACKET_SIZE, TsMuxer } from '../src/ts/muxer';

const hasFfmpeg = spawnSync('ffprobe', ['-version']).status === 0;

function collect() {
  const chunks: Uint8Array[] = [];
  const muxer = new TsMuxer({ onData: (d) => chunks.push(d.slice()) });
  const bytes = () => Buffer.concat(chunks);
  return { muxer, chunks, bytes };
}

function packets(buf: Uint8Array) {
  const out: Uint8Array[] = [];
  for (let i = 0; i < buf.length; i += TS_PACKET_SIZE) out.push(buf.subarray(i, i + TS_PACKET_SIZE));
  return out;
}

const pidOf = (p: Uint8Array) => ((p[1] & 0x1f) << 8) | p[2];

/** Reassemble bounded PES packets on the KLV PID and return their payloads. */
function readKlvPayloads(ts: Uint8Array): Uint8Array[] {
  const payloads: Uint8Array[] = [];
  let pes: number[] = [];
  const flush = () => {
    if (pes.length) payloads.push(new Uint8Array(pes.slice(9 + pes[8], 6 + ((pes[4] << 8) | pes[5]))));
    pes = [];
  };
  for (const p of packets(ts)) {
    if (pidOf(p) !== PID.KLV) continue;
    const start = p[1] & 0x40;
    const offset = p[3] & 0x20 ? 5 + p[4] : 4;
    if (start) flush();
    pes.push(...p.subarray(offset));
  }
  flush();
  return payloads;
}

describe('crc32Mpeg', () => {
  it('matches the CRC-32/MPEG-2 check value', () => {
    expect(crc32Mpeg(new TextEncoder().encode('123456789'))).toBe(0x0376e6e7);
  });
});

describe('splitNalUnits', () => {
  it('handles 3- and 4-byte start codes', () => {
    const data = new Uint8Array([0, 0, 0, 1, 0x67, 1, 2, 0, 0, 1, 0x68, 3, 0, 0, 0, 1, 0x65, 4]);
    expect(splitNalUnits(data).map((n) => [...n])).toEqual([[0x67, 1, 2], [0x68, 3], [0x65, 4]]);
  });
});

describe('TsMuxer', () => {
  it('emits whole 188-byte packets with sync bytes and continuous counters', () => {
    const { muxer, bytes } = collect();
    const frame = new Uint8Array([0, 0, 0, 1, 0x65, ...new Array(1000).fill(0xaa)]);
    for (let i = 0; i < 5; i++) muxer.writeVideo(frame, i * 33_333, i === 0);
    muxer.writeKlv(encodeSt0601({ timestampUs: 1n }), 0);

    const all = bytes();
    expect(all.length % TS_PACKET_SIZE).toBe(0);
    const cc = new Map<number, number>();
    for (const p of packets(all)) {
      expect(p[0]).toBe(0x47);
      const pid = pidOf(p);
      const counter = p[3] & 0x0f;
      if (cc.has(pid)) expect(counter).toBe((cc.get(pid)! + 1) & 0x0f);
      cc.set(pid, counter);
    }
    expect([...cc.keys()].sort()).toEqual([PID.PAT, PID.VIDEO, PID.KLV, PID.PMT].sort());
  });

  it('inserts cached SPS/PPS before an IDR that lacks them', () => {
    const { muxer, bytes } = collect();
    const sc = [0, 0, 0, 1];
    muxer.writeVideo(new Uint8Array([...sc, 0x67, 1, ...sc, 0x68, 2, ...sc, 0x65, 3]), 0, true);
    const before = bytes().length;
    muxer.writeVideo(new Uint8Array([...sc, 0x65, 9]), 1_000_000, true);
    const second = bytes().subarray(before);
    const hex = Buffer.from(second).toString('hex');
    expect(hex).toContain('0000000109f0000000016701000000016802000000016509'); // AUD, SPS, PPS, IDR
  });
});

describe.skipIf(!hasFfmpeg)('TsMuxer with ffmpeg', () => {
  it('produces a stream ffprobe reads as H.264 + KLV with ST 0601 payloads', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tsmux-'));
    const h264 = join(dir, 'in.h264');
    execFileSync('ffmpeg', [
      '-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=30', '-t', '3',
      '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-profile:v', 'baseline', '-g', '30', '-bf', '0',
      '-x264-params', 'aud=1', '-f', 'h264', h264,
    ]);

    // Split the elementary stream into access units at each AUD.
    const es = readFileSync(h264);
    const nals = splitNalUnits(es);
    const units: Uint8Array[][] = [];
    for (const n of nals) {
      if ((n[0] & 0x1f) === 9 || units.length === 0) units.push([]);
      units[units.length - 1].push(n);
    }

    const { muxer, bytes } = collect();
    const sc = new Uint8Array([0, 0, 0, 1]);
    units.forEach((au, i) => {
      const t = Math.round((i * 1_000_000) / 30);
      const data = Buffer.concat(au.flatMap((n) => [sc, n]));
      muxer.writeVideo(data, t, au.some((n) => (n[0] & 0x1f) === 5));
      if (i % 30 === 0) {
        muxer.writeKlv(encodeSt0601({ timestampUs: BigInt(t), sensorLatitude: 10 + i / 30, horizontalFov: 60 }), t);
      }
    });
    const ts = join(dir, 'out.ts');
    writeFileSync(ts, bytes());

    const probe = JSON.parse(
      execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', ts]).toString(),
    );
    const codecs = probe.streams.map((s: { codec_name?: string; codec_type: string }) => s.codec_name ?? s.codec_type);
    expect(codecs).toContain('h264');
    expect(codecs).toContain('klv');
    expect(Number(probe.format.duration)).toBeGreaterThan(2.5);

    // Decoding the whole stream must not produce errors.
    const decode = spawnSync('ffmpeg', ['-v', 'error', '-i', ts, '-map', '0:v', '-f', 'null', '-']);
    expect(decode.stderr.toString()).toBe('');

    // Demux the KLV PES payloads ourselves: ffmpeg 6.1.x wrongly strips 5 bytes
    // (a sync-metadata AU header) from async KLVA streams when extracting them.
    const lats = readKlvPayloads(bytes()).map((klv) => {
      const values = misb.st0601.parse(Buffer.from(klv));
      expect(values.find((v) => v.key === 1)!.valid).not.toBe(false);
      return values.find((v) => v.key === 13)!.value as number;
    });
    expect(lats.map((l) => Math.round(l))).toEqual([10, 11, 12]);
  });
});
