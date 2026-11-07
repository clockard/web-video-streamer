/**
 * Minimal MPEG-2 Transport Stream demuxer: the counterpart of TsMuxer.
 *
 * Reads the PAT and PMT to find the H.264 video, audio (AAC in ADTS, or Opus)
 * and KLV elementary streams, reassembles their PES packets and emits one
 * payload per PES with its timestamps. Packets can arrive in chunks of any
 * size. Continuity-counter gaps (lost or dropped data) are reported so a
 * decoder can wait for the next keyframe.
 */
import { splitNalUnits, TS_PACKET_SIZE } from './muxer';

export type ElementaryKind = 'video' | 'audio' | 'klv';
export type DemuxedAudioCodec = 'aac' | 'opus';

export interface DemuxedSample {
  kind: ElementaryKind;
  pid: number;
  /** Presentation time on the 90 kHz clock (33-bit, wraps). */
  pts?: number;
  /** Decode time on the 90 kHz clock; equals pts when the PES has none. */
  dts?: number;
  /** Elementary-stream payload: an Annex-B access unit, ADTS / Opus-in-TS frames, or a KLV packet. */
  data: Uint8Array;
  /** Video only: the access unit contains an IDR slice. */
  keyframe?: boolean;
  /** Data was lost on this PID since the previous sample. */
  discontinuity: boolean;
}

export interface DemuxedProgram {
  video?: number;
  audio?: { pid: number; codec: DemuxedAudioCodec };
  klv?: number;
}

export interface TsDemuxerOptions {
  onSample: (sample: DemuxedSample) => void;
  /** Called whenever the PMT announces a different set of streams. */
  onProgram?: (program: DemuxedProgram) => void;
}

interface PesBuffer {
  kind: ElementaryKind;
  parts: Uint8Array[];
  length: number;
  /** PES_packet_length-derived total size, or 0 for unbounded (video). */
  expected: number;
  cc: number;
  /** Set after a continuity gap: skip data until the next payload_unit_start. */
  broken: boolean;
  /** A gap happened; reported with the next complete sample. */
  lost: boolean;
}

const STREAM_TYPE_H264 = 0x1b;
const STREAM_TYPE_AAC_ADTS = 0x0f;
const STREAM_TYPE_PRIVATE_PES = 0x06;
const STREAM_TYPE_METADATA = 0x15;

const NAL_IDR = 5;

export class TsDemuxer {
  private pending = new Uint8Array(0);
  private pmtPid?: number;
  private program: DemuxedProgram = {};
  private readonly streams = new Map<number, PesBuffer>();
  private readonly sections = new Map<number, { parts: Uint8Array[]; length: number; cc: number }>();

  constructor(private readonly options: TsDemuxerOptions) {}

  /** The streams announced by the most recent PMT. */
  get currentProgram(): DemuxedProgram {
    return this.program;
  }

  push(chunk: Uint8Array): void {
    let data = chunk;
    if (this.pending.length) {
      data = new Uint8Array(this.pending.length + chunk.length);
      data.set(this.pending);
      data.set(chunk, this.pending.length);
    }
    let i = 0;
    while (i + TS_PACKET_SIZE <= data.length) {
      if (data[i] !== 0x47) {
        // Lost sync: look for the next sync byte.
        i++;
        continue;
      }
      this.packet(data.subarray(i, i + TS_PACKET_SIZE));
      i += TS_PACKET_SIZE;
    }
    this.pending = data.slice(i);
  }

  /** Emit whatever PES data is buffered (e.g. the last unbounded video PES at end of stream). */
  flush(): void {
    for (const [pid, s] of this.streams) this.emit(pid, s);
  }

  private packet(pkt: Uint8Array) {
    const pusi = (pkt[1] & 0x40) !== 0;
    const pid = ((pkt[1] & 0x1f) << 8) | pkt[2];
    const afc = (pkt[3] >> 4) & 0x03;
    const cc = pkt[3] & 0x0f;
    if (!(afc & 0x01)) return; // no payload
    let offset = 4;
    if (afc & 0x02) offset += 1 + pkt[4];
    if (offset >= TS_PACKET_SIZE) return;
    const payload = pkt.subarray(offset);

    if (pid === 0 || pid === this.pmtPid) this.sectionPacket(pid, payload, pusi, cc);
    else if (this.streams.has(pid)) this.pesPacket(pid, this.streams.get(pid)!, payload, pusi, cc);
  }

  private sectionPacket(pid: number, payload: Uint8Array, pusi: boolean, cc: number) {
    let buf = this.sections.get(pid);
    if (pusi) {
      const pointer = payload[0];
      buf = { parts: [payload.subarray(1 + pointer)], length: payload.length - 1 - pointer, cc };
      this.sections.set(pid, buf);
    } else if (buf && cc === ((buf.cc + 1) & 0x0f)) {
      buf.parts.push(payload);
      buf.length += payload.length;
      buf.cc = cc;
    } else {
      this.sections.delete(pid);
      return;
    }
    if (buf.length < 3) return;
    const section = concat(buf.parts, buf.length);
    const sectionLength = ((section[1] & 0x0f) << 8) | section[2];
    if (section.length < 3 + sectionLength) return;
    this.sections.delete(pid);
    const body = section.subarray(0, 3 + sectionLength);
    if (pid === 0 && body[0] === 0x00) this.parsePat(body);
    else if (body[0] === 0x02) this.parsePmt(body);
  }

  private parsePat(section: Uint8Array) {
    // Program loop between the 8-byte header and the 4-byte CRC; use the first real program.
    for (let i = 8; i + 4 <= section.length - 4; i += 4) {
      const program = (section[i] << 8) | section[i + 1];
      if (program === 0) continue; // network PID
      const pid = ((section[i + 2] & 0x1f) << 8) | section[i + 3];
      if (pid !== this.pmtPid) {
        if (this.pmtPid !== undefined) this.sections.delete(this.pmtPid);
        this.pmtPid = pid;
      }
      return;
    }
  }

  private parsePmt(section: Uint8Array) {
    const end = section.length - 4;
    const programInfoLength = ((section[10] & 0x0f) << 8) | section[11];
    const program: DemuxedProgram = {};
    for (let i = 12 + programInfoLength; i + 5 <= end; ) {
      const type = section[i];
      const pid = ((section[i + 1] & 0x1f) << 8) | section[i + 2];
      const infoLength = ((section[i + 3] & 0x0f) << 8) | section[i + 4];
      const descriptors = section.subarray(i + 5, Math.min(i + 5 + infoLength, end));
      i += 5 + infoLength;
      const registration = registrationFormat(descriptors);
      if (type === STREAM_TYPE_H264 && program.video === undefined) program.video = pid;
      else if (type === STREAM_TYPE_AAC_ADTS && !program.audio) program.audio = { pid, codec: 'aac' };
      else if (type === STREAM_TYPE_PRIVATE_PES && registration === 'Opus' && !program.audio) program.audio = { pid, codec: 'opus' };
      else if ((type === STREAM_TYPE_PRIVATE_PES || type === STREAM_TYPE_METADATA) && registration === 'KLVA' && program.klv === undefined) program.klv = pid;
    }

    const kinds = new Map<number, ElementaryKind>();
    if (program.video !== undefined) kinds.set(program.video, 'video');
    if (program.audio) kinds.set(program.audio.pid, 'audio');
    if (program.klv !== undefined) kinds.set(program.klv, 'klv');
    for (const pid of this.streams.keys()) if (kinds.get(pid) !== this.streams.get(pid)!.kind) this.streams.delete(pid);
    for (const [pid, kind] of kinds) {
      if (!this.streams.has(pid)) this.streams.set(pid, { kind, parts: [], length: 0, expected: 0, cc: -1, broken: true, lost: false });
    }

    if (!sameProgram(program, this.program)) {
      this.program = program;
      this.options.onProgram?.(program);
    }
  }

  private pesPacket(pid: number, s: PesBuffer, payload: Uint8Array, pusi: boolean, cc: number) {
    if (s.cc >= 0 && cc !== ((s.cc + 1) & 0x0f)) {
      if (cc === s.cc) return; // duplicate packet
      // Data lost: drop the partial PES and resync at the next start.
      s.parts = [];
      s.length = 0;
      s.broken = true;
      s.lost = true;
    }
    s.cc = cc;

    if (pusi) {
      if (!s.broken) this.emit(pid, s);
      s.parts = [payload];
      s.length = payload.length;
      s.broken = false;
      s.expected = payload.length >= 6 ? ((payload[4] << 8) | payload[5]) : 0;
      if (s.expected) s.expected += 6;
    } else if (!s.broken) {
      s.parts.push(payload);
      s.length += payload.length;
    } else {
      return;
    }
    if (s.expected && s.length >= s.expected) this.emit(pid, s);
  }

  private emit(pid: number, s: PesBuffer) {
    if (!s.length || s.broken) return;
    const pes = concat(s.parts, s.length);
    s.parts = [];
    s.length = 0;
    s.broken = true; // wait for the next payload_unit_start
    if (pes.length < 9 || pes[0] !== 0 || pes[1] !== 0 || pes[2] !== 1) return;
    const flags = pes[7];
    const headerLength = pes[8];
    let pts: number | undefined;
    let dts: number | undefined;
    if (flags & 0x80 && pes.length >= 14) pts = readTimestamp(pes, 9);
    if ((flags & 0xc0) === 0xc0 && pes.length >= 19) dts = readTimestamp(pes, 14);
    const end = s.expected ? Math.min(s.expected, pes.length) : pes.length;
    const data = pes.subarray(9 + headerLength, end);
    if (!data.length) return;
    const sample: DemuxedSample = { kind: s.kind, pid, pts, dts: dts ?? pts, data, discontinuity: s.lost };
    if (s.kind === 'video') sample.keyframe = splitNalUnits(data).some((n) => (n[0] & 0x1f) === NAL_IDR);
    s.lost = false;
    this.options.onSample(sample);
  }
}

function readTimestamp(b: Uint8Array, o: number): number {
  return (((b[o] >> 1) & 0x07) * 2 ** 30) + (((b[o + 1] << 7) | (b[o + 2] >> 1)) << 15) + ((b[o + 3] << 7) | (b[o + 4] >> 1));
}

/** The format_identifier of a registration_descriptor (tag 5) as text, if present. */
function registrationFormat(descriptors: Uint8Array): string | undefined {
  for (let i = 0; i + 2 <= descriptors.length; i += 2 + descriptors[i + 1]) {
    if (descriptors[i] === 0x05 && descriptors[i + 1] >= 4) return String.fromCharCode(...descriptors.subarray(i + 2, i + 6));
  }
  return undefined;
}

function sameProgram(a: DemuxedProgram, b: DemuxedProgram) {
  return a.video === b.video && a.klv === b.klv && a.audio?.pid === b.audio?.pid && a.audio?.codec === b.audio?.codec;
}

function concat(parts: Uint8Array[], length: number): Uint8Array {
  if (parts.length === 1) return parts[0];
  const out = new Uint8Array(length);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
