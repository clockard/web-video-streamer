import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import misb from '@vidterra/misb.js';
import { encodeSt0601 } from '../src/klv/st0601';
import { crc32Mpeg } from '../src/ts/crc32';
import { PID, splitNalUnits, TS_PACKET_SIZE, TsMuxer, type MuxerAudioConfig } from '../src/ts/muxer';
import { parseAudioSpecificConfig, toAdts, toOpusTs, type AacConfig } from '../src/ts/audio';

const hasFfmpeg = spawnSync('ffprobe', ['-version']).status === 0;

function collect(audio?: MuxerAudioConfig) {
  const chunks: Uint8Array[] = [];
  const muxer = new TsMuxer({ onData: (d) => chunks.push(d.slice()), audio });
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

/** The PMT section's elementary-stream loop as [stream_type, pid, descriptor bytes]. */
function pmtStreams(ts: Uint8Array): [number, number, number[]][] {
  const p = packets(ts).find((x) => pidOf(x) === PID.PMT)!;
  const payload = p.subarray(p[3] & 0x20 ? 5 + p[4] : 4); // short sections are stuffed via the adaptation field
  const section = payload.subarray(1 + payload[0]); // skip pointer_field
  const length = ((section[1] & 0x0f) << 8) | section[2];
  const programInfo = ((section[10] & 0x0f) << 8) | section[11];
  const out: [number, number, number[]][] = [];
  for (let i = 12 + programInfo; i < 3 + length - 4; ) {
    const esInfo = ((section[i + 3] & 0x0f) << 8) | section[i + 4];
    out.push([section[i], ((section[i + 1] & 0x1f) << 8) | section[i + 2], [...section.subarray(i + 5, i + 5 + esInfo)]]);
    i += 5 + esInfo;
  }
  return out;
}

describe('TsMuxer audio', () => {
  const idr = new Uint8Array([0, 0, 0, 1, 0x65, 1]);

  it('announces no audio stream when created without audio', () => {
    const { muxer, bytes } = collect();
    muxer.writeVideo(idr, 0, true);
    expect(pmtStreams(bytes()).map((s) => s[1])).toEqual([PID.VIDEO, PID.KLV]);
    expect(() => muxer.writeAudio([new Uint8Array(1)], 0)).toThrow();
  });

  it('announces AAC as ADTS (stream_type 0x0F)', () => {
    const { muxer, bytes } = collect({ codec: 'aac', channels: 1 });
    muxer.writeVideo(idr, 0, true);
    expect(pmtStreams(bytes()).at(-1)).toEqual([0x0f, PID.AUDIO, []]);
  });

  it('announces Opus with registration and extension descriptors', () => {
    const { muxer, bytes } = collect({ codec: 'opus', channels: 2 });
    muxer.writeVideo(idr, 0, true);
    expect(pmtStreams(bytes()).at(-1)).toEqual([0x06, PID.AUDIO, [0x05, 0x04, 0x4f, 0x70, 0x75, 0x73, 0x7f, 0x02, 0x80, 2]]);
  });

  it('writes one bounded audio PES with the PTS of the first frame', () => {
    const { muxer, bytes } = collect({ codec: 'aac', channels: 1 });
    muxer.writeVideo(idr, 0, true);
    const before = bytes().length;
    muxer.writeAudio([new Uint8Array(150).fill(1), new Uint8Array(150).fill(2)], 1_000_000);
    const audio = packets(bytes().subarray(before));
    expect(audio.every((p) => pidOf(p) === PID.AUDIO)).toBe(true);
    expect(audio.length).toBe(2);
    const start = audio[0].subarray(audio[0][3] & 0x20 ? 5 + audio[0][4] : 4);
    expect([...start.subarray(0, 4)]).toEqual([0, 0, 1, 0xc0]);
    expect((start[4] << 8) | start[5]).toBe(300 + 8);
    const pts = (((start[9] >> 1) & 0x07) * 2 ** 30) + ((start[10] << 7 | start[11] >> 1) * 2 ** 15) + (start[12] << 7 | start[13] >> 1);
    expect(pts).toBe(90_000 + 18_000);
  });
});

/** H.264 access units (Annex B) of a ffmpeg test pattern at 30 fps. */
function testVideo(dir: string, seconds: number): { data: Buffer; keyframe: boolean }[] {
  const h264 = join(dir, 'in.h264');
  execFileSync('ffmpeg', [
    '-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=30', '-t', String(seconds),
    '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-profile:v', 'baseline', '-g', '30', '-bf', '0',
    '-x264-params', 'aud=1', '-f', 'h264', h264,
  ]);
  const units: Uint8Array[][] = [];
  for (const n of splitNalUnits(readFileSync(h264))) {
    if ((n[0] & 0x1f) === 9 || units.length === 0) units.push([]);
    units[units.length - 1].push(n);
  }
  const sc = new Uint8Array([0, 0, 0, 1]);
  return units.map((au) => ({ data: Buffer.concat(au.flatMap((n) => [sc, n])), keyframe: au.some((n) => (n[0] & 0x1f) === 5) }));
}

/** Raw AAC frames (ADTS headers stripped) and their config, from ffmpeg's AAC encoder. */
function testAac(dir: string, seconds: number): { config: AacConfig; frames: Uint8Array[] } {
  const file = join(dir, 'in.aac');
  execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', String(seconds), '-ac', '1', '-c:a', 'aac', '-b:a', '64k', '-f', 'adts', file]);
  const adts = readFileSync(file);
  const frames: Uint8Array[] = [];
  let config: AacConfig | undefined;
  for (let i = 0; i + 7 <= adts.length; ) {
    const length = ((adts[i + 3] & 0x03) << 11) | (adts[i + 4] << 3) | (adts[i + 5] >> 5);
    const headerLength = adts[i + 1] & 0x01 ? 7 : 9;
    // Build an AudioSpecificConfig from the ADTS fields, as an encoder's description would be.
    const objectType = (adts[i + 2] >> 6) + 1;
    const index = (adts[i + 2] >> 2) & 0x0f;
    const channels = ((adts[i + 2] & 1) << 2) | (adts[i + 3] >> 6);
    config ??= parseAudioSpecificConfig(new Uint8Array([(objectType << 3) | (index >> 1), ((index & 1) << 7) | (channels << 3)]));
    frames.push(adts.subarray(i + headerLength, i + length));
    i += length;
  }
  return { config: config!, frames };
}

/** Opus packets from an Ogg file made by ffmpeg (OpusHead and OpusTags skipped). */
function testOpus(dir: string, seconds: number): Uint8Array[] {
  const file = join(dir, 'in.opus');
  execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', String(seconds), '-ac', '1', '-c:a', 'libopus', '-b:a', '48k', '-frame_duration', '20', '-f', 'ogg', file]);
  const ogg = readFileSync(file);
  const out: Uint8Array[] = [];
  let partial: Buffer[] = [];
  for (let i = 0; i < ogg.length; ) {
    const segments = ogg[i + 26];
    const table = ogg.subarray(i + 27, i + 27 + segments);
    let o = i + 27 + segments;
    for (const size of table) {
      partial.push(ogg.subarray(o, o + size));
      o += size;
      if (size < 255) {
        out.push(Buffer.concat(partial));
        partial = [];
      }
    }
    i = o;
  }
  return out.slice(2);
}

describe.skipIf(!hasFfmpeg)('TsMuxer audio with ffmpeg', () => {
  for (const codec of ['aac', 'opus'] as const) {
    it(`produces a stream ffprobe reads as H.264 + ${codec} + KLV, with audio aligned to video`, () => {
      const dir = mkdtempSync(join(tmpdir(), `tsmux-${codec}-`));
      const seconds = 3;
      const video = testVideo(dir, seconds);
      let audio: { data: Uint8Array; durationUs: number }[];
      if (codec === 'aac') {
        const { config, frames } = testAac(dir, seconds);
        audio = frames.map((f) => ({ data: toAdts(config, f), durationUs: (1024 * 1e6) / 48000 }));
      } else {
        audio = testOpus(dir, seconds).map((p) => ({ data: toOpusTs(p), durationUs: 20_000 }));
      }

      const { muxer, bytes } = collect({ codec, channels: 1 });
      // Interleave by time, five audio frames per PES as the streamer does.
      let a = 0;
      let audioUs = 0;
      video.forEach((au, i) => {
        const t = Math.round((i * 1_000_000) / 30);
        muxer.writeVideo(au.data, t, au.keyframe);
        if (i % 30 === 0) muxer.writeKlv(encodeSt0601({ timestampUs: BigInt(t), horizontalFov: 60 }), t);
        while (a < audio.length && audioUs <= t) {
          const group = audio.slice(a, a + 5);
          muxer.writeAudio(group.map((g) => g.data), Math.round(audioUs));
          a += group.length;
          audioUs += group.reduce((n, g) => n + g.durationUs, 0);
        }
      });
      const ts = join(dir, 'out.ts');
      writeFileSync(ts, bytes());

      const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-of', 'json', ts]).toString());
      const streams = probe.streams as { codec_name?: string; codec_type: string; start_time: string; channels?: number; sample_rate?: string }[];
      expect(streams.map((s) => s.codec_name ?? s.codec_type)).toEqual(expect.arrayContaining(['h264', 'klv', codec]));
      const audioStream = streams.find((s) => s.codec_type === 'audio')!;
      const videoStream = streams.find((s) => s.codec_name === 'h264')!;
      expect(audioStream.channels).toBe(1);
      expect(audioStream.sample_rate).toBe('48000');
      expect(Math.abs(Number(audioStream.start_time) - Number(videoStream.start_time))).toBeLessThan(0.05);

      // Decode all of the audio without errors and check its length.
      const decode = spawnSync('ffmpeg', ['-v', 'error', '-i', ts, '-map', '0:a', '-f', 'wav', '-']);
      expect(decode.stderr.toString()).toBe('');
      const wavSeconds = (decode.stdout.length - 44) / (48000 * 2);
      expect(wavSeconds).toBeGreaterThan(seconds - 0.2);
    });
  }
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
