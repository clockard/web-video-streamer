import { describe, expect, it } from 'vitest';
import { decodeSt0601, encodeSt0601, type St0601Metadata } from '../src/klv/st0601';
import { audioSpecificConfig, fromAdts, fromOpusTs, parseAudioSpecificConfig, toAdts, toOpusTs } from '../src/ts/audio';
import { TsDemuxer, type DemuxedProgram, type DemuxedSample } from '../src/ts/demuxer';
import { PID, splitNalUnits, TS_PACKET_SIZE, TsMuxer, type MuxerAudioConfig } from '../src/ts/muxer';

const SPS = new Uint8Array([0x67, 0x64, 0x00, 0x1f, 0xac, 0xd9, 0x40]);
const PPS = new Uint8Array([0x68, 0xeb, 0xe3, 0xcb]);
const startCode = [0, 0, 0, 1];

function accessUnit(keyframe: boolean, size: number, seed: number): Uint8Array {
  const slice = new Uint8Array(size);
  slice[0] = keyframe ? 0x65 : 0x41;
  for (let i = 1; i < size; i++) slice[i] = ((i * 7 + seed) % 250) + 3; // never forms a start code
  return new Uint8Array([...(keyframe ? [...startCode, ...SPS, ...startCode, ...PPS] : []), ...startCode, ...slice]);
}

function mux(audio?: MuxerAudioConfig) {
  const chunks: Uint8Array[] = [];
  const muxer = new TsMuxer({ onData: (d) => chunks.push(d.slice()), audio });
  return { muxer, bytes: () => new Uint8Array(Buffer.concat(chunks)) };
}

function demux(bytes: Uint8Array, chunkSizes: () => number = () => bytes.length) {
  const samples: DemuxedSample[] = [];
  const programs: DemuxedProgram[] = [];
  const demuxer = new TsDemuxer({ onSample: (s) => samples.push({ ...s, data: s.data.slice() }), onProgram: (p) => programs.push(p) });
  for (let i = 0; i < bytes.length; ) {
    const n = Math.max(1, chunkSizes());
    demuxer.push(bytes.subarray(i, i + n));
    i += n;
  }
  demuxer.flush();
  return { samples, programs };
}

/** Deterministic pseudo-random chunk sizes. */
function chunker(seed = 1) {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) % 2 ** 31;
    return 1 + (s % 700);
  };
}

const metadata: St0601Metadata = {
  timestampUs: 1_761_800_000_123_456n,
  missionId: 'TEST',
  platformDesignation: 'Mobile Browser',
  imageSourceSensor: 'Pixel 9',
  platformHeading: 123.4,
  platformPitch: 1.5,
  platformRoll: -2.25,
  sensorLatitude: 38.8977,
  sensorLongitude: -77.0365,
  sensorTrueAltitude: 25.5,
  sensorEllipsoidHeight: -8.2,
  horizontalFov: 66.2,
  verticalFov: 39.4,
  sensorRelativeAzimuth: 12,
  sensorRelativeElevation: -12.5,
  sensorRelativeRoll: 358.2,
  slantRange: 8.64,
  frameCenterLatitude: 38.89,
  frameCenterLongitude: -77.035,
  corners: [
    { latitude: 38.901, longitude: -77.04 },
    { latitude: 38.902, longitude: -77.03 },
    { latitude: 38.8978, longitude: -77.0364 },
    { latitude: 38.8977, longitude: -77.0366 },
  ],
};

describe('TsDemuxer', () => {
  it('round-trips video, AAC audio and KLV from TsMuxer in arbitrary chunks', () => {
    const aac = { objectType: 2, sampleRateIndex: 3, channels: 1 };
    const { muxer, bytes } = mux({ codec: 'aac', channels: 1 });
    const units = [accessUnit(true, 3000, 1), accessUnit(false, 400, 2), accessUnit(false, 50, 3), accessUnit(true, 9000, 4)];
    const aacFrames = [new Uint8Array(200).fill(1), new Uint8Array(180).fill(2)];
    const klv = encodeSt0601(metadata);
    units.forEach((u, i) => {
      muxer.writeVideo(u, i * 33_333, i % 3 === 0);
      if (i === 1) muxer.writeAudio(aacFrames.map((f) => toAdts(aac, f)), 40_000);
      if (i === 2) muxer.writeKlv(klv, 66_666);
    });

    const { samples, programs } = demux(bytes(), chunker());
    expect(programs).toEqual([{ video: PID.VIDEO, audio: { pid: PID.AUDIO, codec: 'aac' }, klv: PID.KLV }]);

    const video = samples.filter((s) => s.kind === 'video');
    expect(video.map((s) => s.keyframe)).toEqual([true, false, false, true]);
    // The muxer adds an AUD (and SPS/PPS before IDRs it lacks); the slices must survive unchanged.
    video.forEach((s, i) => {
      const slices = (u: Uint8Array) => splitNalUnits(u).filter((n) => [1, 5].includes(n[0] & 0x1f));
      expect(slices(s.data)).toEqual(slices(units[i]));
      expect(s.pts).toBe(Math.round(i * 33_333 * 0.09) + 18_000);
      expect(s.discontinuity).toBe(false);
    });

    const audio = samples.filter((s) => s.kind === 'audio');
    expect(audio).toHaveLength(1);
    expect(audio[0].pts).toBe(3600 + 18_000);
    const frames = fromAdts(audio[0].data);
    expect(frames.map((f) => f.raw)).toEqual(aacFrames);
    expect(frames[0].config).toEqual(aac);
    expect(parseAudioSpecificConfig(audioSpecificConfig(aac))).toEqual(aac);

    const meta = samples.filter((s) => s.kind === 'klv');
    expect(meta.map((s) => s.data)).toEqual([klv]);
  });

  it('finds Opus audio by its registration descriptor', () => {
    const { muxer, bytes } = mux({ codec: 'opus', channels: 2 });
    const packets = [new Uint8Array(300).fill(9), new Uint8Array(10).fill(8), new Uint8Array(255).fill(7)];
    muxer.writeVideo(accessUnit(true, 100, 1), 0, true);
    muxer.writeAudio(packets.map(toOpusTs), 0);
    muxer.writeVideo(accessUnit(false, 100, 2), 33_333, false);
    const { samples, programs } = demux(bytes());
    expect(programs[0].audio).toEqual({ pid: PID.AUDIO, codec: 'opus' });
    const audio = samples.find((s) => s.kind === 'audio')!;
    expect(fromOpusTs(audio.data)).toEqual(packets);
  });

  it('ignores data before the PAT/PMT and reports lost packets', () => {
    const { muxer, bytes } = mux();
    for (let i = 0; i < 6; i++) muxer.writeVideo(accessUnit(i === 0 || i === 4, 1000, i), i * 33_333, i === 0 || i === 4);
    const all = bytes();
    const packets: Uint8Array[] = [];
    for (let i = 0; i < all.length; i += TS_PACKET_SIZE) packets.push(all.subarray(i, i + TS_PACKET_SIZE));
    const pid = (p: Uint8Array) => ((p[1] & 0x1f) << 8) | p[2];
    const frameStarts = packets.flatMap((p, i) => (pid(p) === PID.VIDEO && p[1] & 0x40 ? [i] : []));

    // Join mid-stream (inside frame 1): nothing comes out until the next PAT/PMT, sent before keyframe 4.
    const late = demux(Buffer.concat(packets.slice(frameStarts[1] + 1)));
    expect(late.samples.map((s) => s.keyframe)).toEqual([true, false]);

    // Drop one packet from the middle of frame 2.
    const lose = frameStarts[2] + 2;
    expect(pid(packets[lose])).toBe(PID.VIDEO);
    const lossy = demux(Buffer.concat(packets.filter((_, i) => i !== lose)));
    const video = lossy.samples.filter((s) => s.kind === 'video');
    expect(video).toHaveLength(5); // frame 2 is lost
    expect(video.map((s) => s.discontinuity)).toEqual([false, false, true, false, false]);
  });
});

describe('decodeSt0601', () => {
  it('inverts encodeSt0601 within quantisation', () => {
    const decoded = decodeSt0601(encodeSt0601(metadata))!;
    expect(decoded.timestampUs).toBe(metadata.timestampUs);
    expect(decoded.missionId).toBe('TEST');
    expect(decoded.platformDesignation).toBe('Mobile Browser');
    expect(decoded.imageSourceSensor).toBe('Pixel 9');
    const numeric: [keyof St0601Metadata, number][] = [
      ['platformHeading', 0.01], ['platformPitch', 0.001], ['platformRoll', 0.002],
      ['sensorLatitude', 1e-6], ['sensorLongitude', 1e-6], ['sensorTrueAltitude', 0.5], ['sensorEllipsoidHeight', 0.5],
      ['horizontalFov', 0.01], ['verticalFov', 0.01], ['sensorRelativeAzimuth', 1e-6], ['sensorRelativeElevation', 1e-6],
      ['sensorRelativeRoll', 1e-6], ['slantRange', 0.01], ['frameCenterLatitude', 1e-6], ['frameCenterLongitude', 1e-6],
    ];
    for (const [key, tolerance] of numeric) {
      expect(Math.abs((decoded[key] as number) - (metadata[key] as number)), key).toBeLessThanOrEqual(tolerance);
    }
    decoded.corners!.forEach((c, i) => {
      expect(c.latitude).toBeCloseTo(metadata.corners![i].latitude, 6);
      expect(c.longitude).toBeCloseTo(metadata.corners![i].longitude, 6);
    });
  });

  it('leaves out tags that were not encoded', () => {
    const decoded = decodeSt0601(encodeSt0601({ timestampUs: 5n, sensorLatitude: -45 }))!;
    expect(decoded).toEqual({ timestampUs: 5n, sensorLatitude: expect.closeTo(-45, 6) });
  });

  it('rejects a bad checksum, wrong key or truncation', () => {
    const packet = encodeSt0601(metadata);
    const bad = packet.slice();
    bad[30] ^= 0xff;
    expect(decodeSt0601(bad)).toBeUndefined();
    const key = packet.slice();
    key[0] = 0;
    expect(decodeSt0601(key)).toBeUndefined();
    expect(decodeSt0601(packet.subarray(0, packet.length - 5))).toBeUndefined();
  });
});
