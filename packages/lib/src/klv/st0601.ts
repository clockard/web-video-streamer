/**
 * MISB ST 0601 (UAS Datalink Local Set) encoder.
 *
 * Only the tags this library produces are implemented. Each value is mapped
 * from engineering units to the integer encoding defined by the standard.
 */

/** 16-byte Universal Label key for the UAS Datalink Local Set. */
export const ST0601_KEY = new Uint8Array([
  0x06, 0x0e, 0x2b, 0x34, 0x02, 0x0b, 0x01, 0x01, 0x0e, 0x01, 0x03, 0x01, 0x01, 0x00, 0x00, 0x00,
]);

export const ST0601_VERSION = 17;

export const Tag = {
  Checksum: 1,
  PrecisionTimeStamp: 2,
  MissionId: 3,
  PlatformHeading: 5,
  PlatformPitch: 6,
  PlatformRoll: 7,
  PlatformDesignation: 10,
  ImageSourceSensor: 11,
  SensorLatitude: 13,
  SensorLongitude: 14,
  SensorTrueAltitude: 15,
  SensorHorizontalFov: 16,
  SensorVerticalFov: 17,
  SensorRelativeAzimuth: 18,
  SensorRelativeElevation: 19,
  SensorRelativeRoll: 20,
  SlantRange: 21,
  FrameCenterLatitude: 23,
  FrameCenterLongitude: 24,
  UasLsVersion: 65,
  SensorEllipsoidHeight: 75,
  /** Full-range corner coordinates: 82/83 point 1 lat/lon ... 88/89 point 4. */
  CornerLatitudePoint1Full: 82,
} as const;

/** Metadata in engineering units. Omitted (undefined) fields are not encoded. */
export interface St0601Metadata {
  /** Microseconds since the UNIX epoch. */
  timestampUs: bigint;
  missionId?: string;
  platformDesignation?: string;
  imageSourceSensor?: string;
  /** Degrees, 0..360. */
  platformHeading?: number;
  /** Degrees, ±20. */
  platformPitch?: number;
  /** Degrees, ±50. */
  platformRoll?: number;
  /** Degrees, ±90. */
  sensorLatitude?: number;
  /** Degrees, ±180. */
  sensorLongitude?: number;
  /** Metres above MSL, -900..19000. */
  sensorTrueAltitude?: number;
  /** Metres above the WGS84 ellipsoid, -900..19000. */
  sensorEllipsoidHeight?: number;
  /** Degrees, 0..180. */
  horizontalFov?: number;
  /** Degrees, 0..180. */
  verticalFov?: number;
  /** Degrees, 0..360. */
  sensorRelativeAzimuth?: number;
  /** Degrees, ±180. */
  sensorRelativeElevation?: number;
  /** Degrees, 0..360. */
  sensorRelativeRoll?: number;
  /** Metres from sensor to frame centre, 0..5,000,000. */
  slantRange?: number;
  /** Degrees, ±90. */
  frameCenterLatitude?: number;
  /** Degrees, ±180. */
  frameCenterLongitude?: number;
  /** Ground corners: upper-left, upper-right, lower-right, lower-left (tags 82-89). */
  corners?: { latitude: number; longitude: number }[];
}

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));
const wrap360 = (deg: number) => ((deg % 360) + 360) % 360;

function uint(value: number, bytes: number): Uint8Array {
  const out = new Uint8Array(bytes);
  let v = Math.round(value);
  for (let i = bytes - 1; i >= 0; i--) {
    out[i] = v & 0xff;
    v = Math.floor(v / 256);
  }
  return out;
}

function int(value: number, bytes: number): Uint8Array {
  const v = Math.round(value);
  return uint(v < 0 ? v + 2 ** (bytes * 8) : v, bytes);
}

function uint64(value: bigint): Uint8Array {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, value);
  return out;
}

/** Map an unsigned range [0, max] onto an n-byte unsigned integer. */
const mapUnsigned = (deg: number, max: number, bytes: number) =>
  uint((clamp(deg, 0, max) / max) * (2 ** (bytes * 8) - 1), bytes);

/** Map a symmetric range [-max, max] onto an n-byte signed integer (min value reserved for errors). */
const mapSigned = (deg: number, max: number, bytes: number) =>
  int((clamp(deg, -max, max) / max) * (2 ** (bytes * 8 - 1) - 1), bytes);

/** Altitude mapping shared by tags 15 and 75: -900..19000 m onto uint16. */
const altitude = (m: number) => uint(((clamp(m, -900, 19000) + 900) / 19900) * 0xffff, 2);

const ascii =(s: string) => new TextEncoder().encode(s.replace(/[^\x20-\x7e]/g, '').slice(0, 127));

/** BER length encoding (short form below 128, long form otherwise). */
export function berLength(len: number): Uint8Array {
  if (len < 128) return new Uint8Array([len]);
  const bytes: number[] = [];
  for (let v = len; v > 0; v = Math.floor(v / 256)) bytes.unshift(v & 0xff);
  return new Uint8Array([0x80 | bytes.length, ...bytes]);
}

/** ST 0601 checksum: 16-bit running sum over the packet, excluding the final two checksum bytes. */
export function checksum(packet: Uint8Array, length = packet.length - 2): number {
  let sum = 0;
  for (let i = 0; i < length; i++) sum += packet[i] << (8 * ((i + 1) % 2));
  return sum & 0xffff;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

/** Encode metadata as a complete ST 0601 KLV packet (key, BER length, local set). */
export function encodeSt0601(m: St0601Metadata): Uint8Array {
  const items: [number, Uint8Array][] = [[Tag.PrecisionTimeStamp, uint64(m.timestampUs)]];
  const add = (tag: number, value: number | string | undefined, enc: (v: never) => Uint8Array) => {
    if (value === undefined || (typeof value === 'number' && !Number.isFinite(value))) return;
    items.push([tag, enc(value as never)]);
  };

  add(Tag.MissionId, m.missionId, ascii);
  add(Tag.PlatformHeading, m.platformHeading, (v: number) => mapUnsigned(wrap360(v), 360, 2));
  add(Tag.PlatformPitch, m.platformPitch, (v: number) => mapSigned(v, 20, 2));
  add(Tag.PlatformRoll, m.platformRoll, (v: number) => mapSigned(v, 50, 2));
  add(Tag.PlatformDesignation, m.platformDesignation, ascii);
  add(Tag.ImageSourceSensor, m.imageSourceSensor, ascii);
  add(Tag.SensorLatitude, m.sensorLatitude, (v: number) => mapSigned(v, 90, 4));
  add(Tag.SensorLongitude, m.sensorLongitude, (v: number) => mapSigned(v, 180, 4));
  add(Tag.SensorTrueAltitude, m.sensorTrueAltitude, altitude);
  add(Tag.SensorHorizontalFov, m.horizontalFov, (v: number) => mapUnsigned(v, 180, 2));
  add(Tag.SensorVerticalFov, m.verticalFov, (v: number) => mapUnsigned(v, 180, 2));
  add(Tag.SensorRelativeAzimuth, m.sensorRelativeAzimuth, (v: number) => mapUnsigned(wrap360(v), 360, 4));
  add(Tag.SensorRelativeElevation, m.sensorRelativeElevation, (v: number) => mapSigned(v, 180, 4));
  add(Tag.SensorRelativeRoll, m.sensorRelativeRoll, (v: number) => mapUnsigned(wrap360(v), 360, 4));
  add(Tag.SlantRange, m.slantRange, (v: number) => mapUnsigned(v, 5_000_000, 4));
  add(Tag.FrameCenterLatitude, m.frameCenterLatitude, (v: number) => mapSigned(v, 90, 4));
  add(Tag.FrameCenterLongitude, m.frameCenterLongitude, (v: number) => mapSigned(v, 180, 4));
  items.push([Tag.UasLsVersion, new Uint8Array([ST0601_VERSION])]);
  add(Tag.SensorEllipsoidHeight, m.sensorEllipsoidHeight, altitude);
  if (m.corners?.length === 4) {
    m.corners.forEach((c, i) => {
      add(Tag.CornerLatitudePoint1Full + i * 2, c.latitude, (v: number) => mapSigned(v, 90, 4));
      add(Tag.CornerLatitudePoint1Full + i * 2 + 1, c.longitude, (v: number) => mapSigned(v, 180, 4));
    });
  }

  const body = items.flatMap(([tag, value]) => [new Uint8Array([tag]), berLength(value.length), value]);
  // Checksum item placeholder; its tag and length bytes are covered by the checksum.
  body.push(new Uint8Array([Tag.Checksum, 2, 0, 0]));
  const payload = concat(body);
  const packet = concat([ST0601_KEY, berLength(payload.length), payload]);

  const sum = checksum(packet);
  packet[packet.length - 2] = sum >> 8;
  packet[packet.length - 1] = sum & 0xff;
  return packet;
}

function readUint(b: Uint8Array): number {
  let v = 0;
  for (const byte of b) v = v * 256 + byte;
  return v;
}

function readInt(b: Uint8Array): number {
  const v = readUint(b);
  return v >= 2 ** (b.length * 8 - 1) ? v - 2 ** (b.length * 8) : v;
}

/** Inverse of mapUnsigned. */
const unmapUnsigned = (b: Uint8Array, max: number) => (readUint(b) / (2 ** (b.length * 8) - 1)) * max;

/** Inverse of mapSigned; the reserved minimum value ("error") decodes as undefined. */
function unmapSigned(b: Uint8Array, max: number): number | undefined {
  const v = readInt(b);
  if (v === -(2 ** (b.length * 8 - 1))) return undefined;
  return (v / (2 ** (b.length * 8 - 1) - 1)) * max;
}

const unaltitude = (b: Uint8Array) => (readUint(b) / 0xffff) * 19900 - 900;

/** Read a BER length at `offset`: [length, bytes used], or undefined if truncated. */
function readBerLength(b: Uint8Array, offset: number): [number, number] | undefined {
  if (offset >= b.length) return undefined;
  const first = b[offset];
  if (first < 128) return [first, 1];
  const n = first & 0x7f;
  if (n === 0 || n > 4 || offset + 1 + n > b.length) return undefined;
  return [readUint(b.subarray(offset + 1, offset + 1 + n)), 1 + n];
}

/**
 * Decode an ST 0601 KLV packet (key, BER length, local set). Returns undefined
 * if the key, length or checksum is wrong, or the timestamp is missing. Only
 * the tags this library encodes (see `Tag`) are read; others are skipped.
 */
export function decodeSt0601(packet: Uint8Array): St0601Metadata | undefined {
  if (packet.length < ST0601_KEY.length + 1) return undefined;
  for (let i = 0; i < ST0601_KEY.length; i++) {
    // Byte 5 (the registry designator) may vary between encoders; the others identify the local set.
    if (i !== 5 && packet[i] !== ST0601_KEY[i]) return undefined;
  }
  const len = readBerLength(packet, ST0601_KEY.length);
  if (!len) return undefined;
  const start = ST0601_KEY.length + len[1];
  const end = start + len[0];
  if (end > packet.length) return undefined;

  const m: Partial<St0601Metadata> = {};
  const corners: Partial<{ latitude: number; longitude: number }>[] = [{}, {}, {}, {}];
  const text = (b: Uint8Array) => new TextDecoder().decode(b);
  let checked = false;

  for (let i = start; i < end; ) {
    const tag = packet[i];
    const l = readBerLength(packet, i + 1);
    if (!l) return undefined;
    const vStart = i + 1 + l[1];
    const v = packet.subarray(vStart, vStart + l[0]);
    if (vStart + l[0] > end) return undefined;

    switch (tag) {
      case Tag.Checksum:
        if (l[0] !== 2 || readUint(v) !== checksum(packet, vStart)) return undefined;
        checked = true;
        break;
      case Tag.PrecisionTimeStamp:
        if (v.length === 8) m.timestampUs = new DataView(v.buffer, v.byteOffset, 8).getBigUint64(0);
        break;
      case Tag.MissionId: m.missionId = text(v); break;
      case Tag.PlatformHeading: m.platformHeading = unmapUnsigned(v, 360); break;
      case Tag.PlatformPitch: m.platformPitch = unmapSigned(v, 20); break;
      case Tag.PlatformRoll: m.platformRoll = unmapSigned(v, 50); break;
      case Tag.PlatformDesignation: m.platformDesignation = text(v); break;
      case Tag.ImageSourceSensor: m.imageSourceSensor = text(v); break;
      case Tag.SensorLatitude: m.sensorLatitude = unmapSigned(v, 90); break;
      case Tag.SensorLongitude: m.sensorLongitude = unmapSigned(v, 180); break;
      case Tag.SensorTrueAltitude: m.sensorTrueAltitude = unaltitude(v); break;
      case Tag.SensorHorizontalFov: m.horizontalFov = unmapUnsigned(v, 180); break;
      case Tag.SensorVerticalFov: m.verticalFov = unmapUnsigned(v, 180); break;
      case Tag.SensorRelativeAzimuth: m.sensorRelativeAzimuth = unmapUnsigned(v, 360); break;
      case Tag.SensorRelativeElevation: m.sensorRelativeElevation = unmapSigned(v, 180); break;
      case Tag.SensorRelativeRoll: m.sensorRelativeRoll = unmapUnsigned(v, 360); break;
      case Tag.SlantRange: m.slantRange = unmapUnsigned(v, 5_000_000); break;
      case Tag.FrameCenterLatitude: m.frameCenterLatitude = unmapSigned(v, 90); break;
      case Tag.FrameCenterLongitude: m.frameCenterLongitude = unmapSigned(v, 180); break;
      case Tag.SensorEllipsoidHeight: m.sensorEllipsoidHeight = unaltitude(v); break;
      default:
        if (tag >= Tag.CornerLatitudePoint1Full && tag < Tag.CornerLatitudePoint1Full + 8) {
          const n = tag - Tag.CornerLatitudePoint1Full;
          const corner = corners[n >> 1];
          if (n % 2) corner.longitude = unmapSigned(v, 180);
          else corner.latitude = unmapSigned(v, 90);
        }
    }
    i = vStart + l[0];
  }

  if (!checked || m.timestampUs === undefined) return undefined;
  if (corners.every((c) => c.latitude !== undefined && c.longitude !== undefined)) {
    m.corners = corners as { latitude: number; longitude: number }[];
  }
  for (const k of Object.keys(m) as (keyof St0601Metadata)[]) if (m[k] === undefined) delete m[k];
  return m as St0601Metadata;
}
