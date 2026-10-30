/**
 * Minimal MPEG-2 Transport Stream muxer for one H.264 video stream plus one
 * asynchronous KLV metadata stream (MISB ST 1402 / ST 0604 style carriage).
 */
import { crc32Mpeg } from './crc32';

export const TS_PACKET_SIZE = 188;

export const PID = {
  PAT: 0x0000,
  PMT: 0x1000,
  VIDEO: 0x0100,
  KLV: 0x0101,
} as const;

const STREAM_TYPE_H264 = 0x1b;
const STREAM_TYPE_PRIVATE_PES = 0x06;
const STREAM_ID_VIDEO = 0xe0;
const STREAM_ID_PRIVATE_1 = 0xbd;
const PROGRAM_NUMBER = 1;

/** Delay between PCR and presentation time, giving receivers room to buffer. */
const PTS_OFFSET_90K = 18_000; // 200 ms
/**
 * PAT/PMT repetition. They are also sent before every keyframe; 500 ms is the
 * longest PAT interval broadcast monitoring (ETSI TR 101 290) accepts.
 */
const PSI_INTERVAL_US = 500_000;

export interface MuxerOptions {
  /** Called with one or more whole 188-byte TS packets. */
  onData: (packets: Uint8Array) => void;
}

const NAL_AUD = 9;
const NAL_SPS = 7;
const NAL_PPS = 8;
const AUD = new Uint8Array([0, 0, 0, 1, 0x09, 0xf0]);

/** Split an Annex-B byte stream into NAL units (without start codes). */
export function splitNalUnits(data: Uint8Array): Uint8Array[] {
  const units: Uint8Array[] = [];
  let start = -1;
  let i = 0;
  while (i + 2 < data.length) {
    if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 1) {
      if (start >= 0) {
        // Trailing zero belongs to a 4-byte start code of the next unit.
        let end = i;
        while (end > start && data[end - 1] === 0) end--;
        units.push(data.subarray(start, end));
      }
      i += 3;
      start = i;
    } else {
      i++;
    }
  }
  if (start >= 0 && start < data.length) units.push(data.subarray(start));
  return units;
}

function writePts(buf: Uint8Array, offset: number, marker: number, pts: number) {
  // 33-bit timestamp split 3/15/15 with marker bits.
  const high = Math.floor(pts / 2 ** 30) & 0x07;
  const mid = Math.floor(pts / 2 ** 15) & 0x7fff;
  const low = pts & 0x7fff;
  buf[offset] = (marker << 4) | (high << 1) | 1;
  buf[offset + 1] = mid >> 7;
  buf[offset + 2] = ((mid & 0x7f) << 1) | 1;
  buf[offset + 3] = low >> 7;
  buf[offset + 4] = ((low & 0x7f) << 1) | 1;
}

function buildPesHeader(streamId: number, pts: number, payloadLength: number, bounded: boolean): Uint8Array {
  const header = new Uint8Array(14);
  header.set([0, 0, 1, streamId]);
  const pesLength = bounded ? payloadLength + 8 : 0; // 8 = flags(3) + PTS(5)
  header[4] = pesLength >> 8;
  header[5] = pesLength & 0xff;
  header[6] = 0x84; // '10' marker, data_alignment_indicator
  header[7] = 0x80; // PTS only
  header[8] = 5;
  writePts(header, 9, 0b0010, pts);
  return header;
}

export class TsMuxer {
  private readonly onData: (packets: Uint8Array) => void;
  private readonly cc = new Map<number, number>();
  private lastPsiUs = -Infinity;
  private sps?: Uint8Array;
  private pps?: Uint8Array;

  constructor(options: MuxerOptions) {
    this.onData = options.onData;
  }

  /**
   * Write one H.264 access unit in Annex-B format.
   * @param timestampUs presentation time in microseconds on the shared stream clock
   */
  writeVideo(annexB: Uint8Array, timestampUs: number, keyframe: boolean): void {
    if (keyframe || timestampUs - this.lastPsiUs >= PSI_INTERVAL_US) this.writePsi(timestampUs);
    const au = this.prepareAccessUnit(annexB, keyframe);
    const pts = this.to90k(timestampUs) + PTS_OFFSET_90K;
    const pes = this.concat([buildPesHeader(STREAM_ID_VIDEO, pts, au.length, false), au]);
    this.packetize(PID.VIDEO, pes, { pcr27: this.to90k(timestampUs) * 300, randomAccess: keyframe });
  }

  /** Write one KLV packet (e.g. an ST 0601 local set). */
  writeKlv(klv: Uint8Array, timestampUs: number): void {
    const pts = this.to90k(timestampUs) + PTS_OFFSET_90K;
    const pes = this.concat([buildPesHeader(STREAM_ID_PRIVATE_1, pts, klv.length, true), klv]);
    this.packetize(PID.KLV, pes, {});
  }

  private to90k(us: number): number {
    return Math.round((us * 9) / 100) % 2 ** 33;
  }

  /** Ensure an AUD leads the access unit and SPS/PPS precede every IDR. */
  private prepareAccessUnit(annexB: Uint8Array, keyframe: boolean): Uint8Array {
    const nals = splitNalUnits(annexB);
    const types = nals.map((n) => n[0] & 0x1f);
    nals.forEach((n, i) => {
      if (types[i] === NAL_SPS) this.sps = n;
      if (types[i] === NAL_PPS) this.pps = n;
    });
    const startCode = new Uint8Array([0, 0, 0, 1]);
    const parts: Uint8Array[] = [AUD];
    if (keyframe && !types.includes(NAL_SPS) && this.sps && this.pps) {
      parts.push(startCode, this.sps, startCode, this.pps);
    }
    nals.forEach((n, i) => {
      if (types[i] !== NAL_AUD) parts.push(startCode, n);
    });
    return this.concat(parts);
  }

  private writePsi(timestampUs: number) {
    this.lastPsiUs = timestampUs;
    // PAT: program 1 -> PMT PID
    const pat = this.section(0x00, 0x0001, [
      PROGRAM_NUMBER >> 8, PROGRAM_NUMBER & 0xff, 0xe0 | (PID.PMT >> 8), PID.PMT & 0xff,
    ]);
    this.packetize(PID.PAT, this.withPointer(pat), {});

    const klvRegistration = [0x05, 0x04, 0x4b, 0x4c, 0x56, 0x41]; // registration_descriptor "KLVA"
    const pmt = this.section(0x02, PROGRAM_NUMBER, [
      0xe0 | (PID.VIDEO >> 8), PID.VIDEO & 0xff, // PCR PID
      0xf0, 0x00, // program_info_length
      STREAM_TYPE_H264, 0xe0 | (PID.VIDEO >> 8), PID.VIDEO & 0xff, 0xf0, 0x00,
      STREAM_TYPE_PRIVATE_PES, 0xe0 | (PID.KLV >> 8), PID.KLV & 0xff, 0xf0, klvRegistration.length,
      ...klvRegistration,
    ]);
    this.packetize(PID.PMT, this.withPointer(pmt), {});
  }

  private section(tableId: number, tableIdExtension: number, body: number[]): Uint8Array {
    const length = 5 + body.length + 4; // header after length field + body + CRC
    const bytes = new Uint8Array(3 + length);
    bytes.set([
      tableId,
      0xb0 | (length >> 8), length & 0xff,
      tableIdExtension >> 8, tableIdExtension & 0xff,
      0xc1, // version 0, current_next_indicator
      0x00, 0x00, // section_number, last_section_number
      ...body,
    ]);
    const crc = crc32Mpeg(bytes.subarray(0, bytes.length - 4));
    new DataView(bytes.buffer).setUint32(bytes.length - 4, crc);
    return bytes;
  }

  private withPointer(section: Uint8Array): Uint8Array {
    return this.concat([new Uint8Array([0]), section]);
  }

  private packetize(pid: number, payload: Uint8Array, opts: { pcr27?: number; randomAccess?: boolean }) {
    const count = this.estimatePackets(payload.length, opts.pcr27 !== undefined || !!opts.randomAccess);
    const out = new Uint8Array(count * TS_PACKET_SIZE);
    let offset = 0;
    let written = 0;
    let first = true;

    while (offset < payload.length) {
      const pkt = out.subarray(written * TS_PACKET_SIZE, (written + 1) * TS_PACKET_SIZE);
      const cc = this.cc.get(pid) ?? 0;
      this.cc.set(pid, (cc + 1) & 0x0f);

      pkt[0] = 0x47;
      pkt[1] = (first ? 0x40 : 0) | ((pid >> 8) & 0x1f);
      pkt[2] = pid & 0xff;

      // Adaptation field contents (excluding its length byte).
      const af: number[] = [];
      if (first && (opts.pcr27 !== undefined || opts.randomAccess)) {
        let flags = 0;
        if (opts.randomAccess) flags |= 0x40;
        if (opts.pcr27 !== undefined) flags |= 0x10;
        af.push(flags);
        if (opts.pcr27 !== undefined) af.push(...this.pcrBytes(opts.pcr27));
      }

      const remaining = payload.length - offset;
      let headerLen = 4 + (af.length ? 1 + af.length : 0);
      let space = TS_PACKET_SIZE - headerLen;

      if (remaining < space) {
        // Stuff the adaptation field so the payload ends exactly at the packet boundary.
        const stuffing = space - remaining;
        if (af.length === 0) {
          // An empty adaptation field still needs its length byte (+ flags byte if longer than 1).
          if (stuffing === 1) {
            headerLen += 1;
          } else {
            af.push(0x00, ...new Array(stuffing - 2).fill(0xff));
            headerLen += stuffing;
          }
        } else {
          af.push(...new Array(stuffing).fill(0xff));
          headerLen += stuffing;
        }
        space = remaining;
      }

      const hasAf = headerLen > 4;
      pkt[3] = (hasAf ? 0x30 : 0x10) | cc;
      if (hasAf) {
        pkt[4] = af.length; // adaptation_field_length (0 when only the length byte is present)
        pkt.set(af, 5);
      }
      pkt.set(payload.subarray(offset, offset + space), headerLen);
      offset += space;
      written++;
      first = false;
    }
    this.onData(out.subarray(0, written * TS_PACKET_SIZE));
  }

  private estimatePackets(len: number, firstHasAf: boolean): number {
    const firstSpace = TS_PACKET_SIZE - 4 - (firstHasAf ? 8 : 0);
    return len <= firstSpace ? 1 : 1 + Math.ceil((len - firstSpace) / (TS_PACKET_SIZE - 4));
  }

  private pcrBytes(pcr27: number): number[] {
    const base = Math.floor(pcr27 / 300) % 2 ** 33;
    const ext = Math.floor(pcr27) % 300;
    return [
      Math.floor(base / 2 ** 25) & 0xff,
      Math.floor(base / 2 ** 17) & 0xff,
      Math.floor(base / 2 ** 9) & 0xff,
      Math.floor(base / 2) & 0xff,
      ((base & 1) << 7) | 0x7e | ((ext >> 8) & 1),
      ext & 0xff,
    ];
  }

  private concat(parts: Uint8Array[]): Uint8Array {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let o = 0;
    for (const p of parts) {
      out.set(p, o);
      o += p.length;
    }
    return out;
  }
}
