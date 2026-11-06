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
