/**
 * Elementary-stream framing for audio carried in MPEG-TS: ADTS headers for
 * AAC (ISO/IEC 13818-7) and the Opus control header used for Opus in TS
 * (ETSI TS 102 366-style carriage as implemented by ffmpeg and VLC).
 */

const SAMPLE_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];

/** ADTS sampling_frequency_index for a sample rate, or -1 if AAC cannot signal it. */
export function sampleRateIndex(sampleRate: number): number {
  return SAMPLE_RATES.indexOf(sampleRate);
}

export interface AacConfig {
  /** Audio object type: 2 = AAC-LC. */
  objectType: number;
  sampleRateIndex: number;
  channels: number;
}

/** Parse the leading fields of an AudioSpecificConfig (as in AudioEncoder's decoderConfig.description). */
export function parseAudioSpecificConfig(asc: Uint8Array): AacConfig | undefined {
  if (asc.length < 2) return undefined;
  const objectType = asc[0] >> 3;
  const index = ((asc[0] & 0x07) << 1) | (asc[1] >> 7);
  const channels = (asc[1] >> 3) & 0x0f;
  // Explicit sample rates (index 15) and extended object types are not representable in ADTS.
  if (objectType === 0 || objectType === 31 || index > 12) return undefined;
  return { objectType, sampleRateIndex: index, channels };
}

/** 7-byte ADTS header (no CRC) for one raw AAC frame of `payloadLength` bytes. */
export function adtsHeader(config: AacConfig, payloadLength: number): Uint8Array {
  const frameLength = payloadLength + 7;
  if (frameLength > 0x1fff) throw new RangeError(`AAC frame too long for ADTS: ${payloadLength} bytes`);
  const profile = config.objectType - 1;
  return new Uint8Array([
    0xff,
    0xf1, // syncword, MPEG-4, layer 0, no CRC
    ((profile & 0x03) << 6) | ((config.sampleRateIndex & 0x0f) << 2) | ((config.channels >> 2) & 0x01),
    ((config.channels & 0x03) << 6) | ((frameLength >> 11) & 0x03),
    (frameLength >> 3) & 0xff,
    ((frameLength & 0x07) << 5) | 0x1f, // buffer fullness 0x7FF (VBR)
    0xfc, // rest of buffer fullness, one raw data block
  ]);
}

/** Prefix a raw AAC frame with its ADTS header. */
export function toAdts(config: AacConfig, raw: Uint8Array): Uint8Array {
  const out = new Uint8Array(raw.length + 7);
  out.set(adtsHeader(config, raw.length));
  out.set(raw, 7);
  return out;
}

/** opus_control_header: 0x7FE0 prefix, then au_size as a run of 0xFF bytes plus a final remainder byte. */
export function opusControlHeader(size: number): Uint8Array {
  const run = Math.floor(size / 255);
  const out = new Uint8Array(2 + run + 1);
  out[0] = 0x7f;
  out[1] = 0xe0; // no trim/extension flags
  out.fill(0xff, 2, 2 + run);
  out[2 + run] = size % 255;
  return out;
}

/** An Opus packet with its control header, as carried in a TS PES payload. */
export function toOpusTs(packet: Uint8Array): Uint8Array {
  const header = opusControlHeader(packet.length);
  const out = new Uint8Array(header.length + packet.length);
  out.set(header);
  out.set(packet, header.length);
  return out;
}

export interface AdtsFrame {
  config: AacConfig;
  /** The raw AAC frame, without its ADTS header. */
  raw: Uint8Array;
}

/** Split a buffer of back-to-back ADTS frames into raw AAC frames; stops at the first malformed header. */
export function fromAdts(data: Uint8Array): AdtsFrame[] {
  const frames: AdtsFrame[] = [];
  let i = 0;
  while (i + 7 <= data.length && data[i] === 0xff && (data[i + 1] & 0xf0) === 0xf0) {
    const protectionAbsent = data[i + 1] & 0x01;
    const headerLength = protectionAbsent ? 7 : 9;
    const frameLength = ((data[i + 3] & 0x03) << 11) | (data[i + 4] << 3) | (data[i + 5] >> 5);
    if (frameLength < headerLength || i + frameLength > data.length) break;
    const config: AacConfig = {
      objectType: (data[i + 2] >> 6) + 1,
      sampleRateIndex: (data[i + 2] >> 2) & 0x0f,
      channels: ((data[i + 2] & 0x01) << 2) | (data[i + 3] >> 6),
    };
    frames.push({ config, raw: data.subarray(i + headerLength, i + frameLength) });
    i += frameLength;
  }
  return frames;
}

/** Sample rate for an ADTS / AudioSpecificConfig sampling_frequency_index. */
export const sampleRateFromIndex = (index: number): number | undefined => SAMPLE_RATES[index];

/** 2-byte AudioSpecificConfig (as WebCodecs AudioDecoder's description) for an AAC config. */
export function audioSpecificConfig(config: AacConfig): Uint8Array {
  return new Uint8Array([
    (config.objectType << 3) | (config.sampleRateIndex >> 1),
    ((config.sampleRateIndex & 0x01) << 7) | (config.channels << 3),
  ]);
}

/**
 * Split a PES payload of Opus packets, each with its control header, into the
 * bare packets. Trim and extension fields (written by other muxers) are skipped.
 */
export function fromOpusTs(data: Uint8Array): Uint8Array[] {
  const packets: Uint8Array[] = [];
  let i = 0;
  while (i + 2 < data.length && data[i] === 0x7f && (data[i + 1] & 0xe0) === 0xe0) {
    const flags = data[i + 1];
    i += 2;
    let size = 0;
    while (i < data.length) {
      const b = data[i++];
      size += b;
      if (b !== 0xff) break;
    }
    if (flags & 0x10) i += 2; // start_trim
    if (flags & 0x08) i += 2; // end_trim
    if (flags & 0x04) i += 1 + (data[i] ?? 0); // control_extension
    if (i + size > data.length) break;
    packets.push(data.subarray(i, i + size));
    i += size;
  }
  return packets;
}
