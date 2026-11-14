/**
 * Byte helpers for Media over QUIC Transport (MOQT) draft 22.
 *
 * Draft 22 variable-length integers are not QUIC's 2-bit-prefix form: the
 * number of leading 1 bits in the first byte gives the extra bytes. An n-byte
 * integer (n <= 8) carries 7n bits after its n-1 ones and a zero; 0xFF is
 * followed by a full 64-bit value.
 *
 *   0xxxxxxx                     7 bits
 *   10xxxxxx +1 byte            14 bits
 *   110xxxxx +2                 21 bits
 *   ...
 *   11111110 +7                 56 bits
 *   11111111 +8                 64 bits
 */

export const MAX_VARINT = 2n ** 64n - 1n;

/** Encode an unsigned integer as a draft-22 varint. */
export function encodeVarint(value: number | bigint): Uint8Array {
  const v = BigInt(value);
  if (v < 0n || v > MAX_VARINT) throw new RangeError(`varint out of range: ${value}`);
  for (let n = 1; n <= 8; n++) {
    if (v < 1n << BigInt(7 * n)) {
      const out = new Uint8Array(n);
      for (let i = n - 1, x = v; i >= 0; i--, x >>= 8n) out[i] = Number(x & 0xffn);
      // n-1 leading ones then a zero (for n = 8 the prefix is the whole first byte, 0xFE).
      out[0] |= (0xff << (9 - n)) & 0xff;
      return out;
    }
  }
  const out = new Uint8Array(9);
  out[0] = 0xff;
  for (let i = 8, x = v; i >= 1; i--, x >>= 8n) out[i] = Number(x & 0xffn);
  return out;
}

/** Bytes taken by the varint whose first byte is `first`. */
export function varintSize(first: number): number {
  let n = 1;
  while (n <= 8 && first & (0x80 >> (n - 1))) n++;
  return n;
}

/** Decode the varint at `offset`. */
export function decodeVarint(bytes: Uint8Array, offset = 0): { value: bigint; size: number } {
  if (offset >= bytes.length) throw new RangeError('varint past end of buffer');
  const size = varintSize(bytes[offset]);
  if (offset + size > bytes.length) throw new RangeError('truncated varint');
  // Bits of the first byte left after the prefix: 7 for n=1 down to 0 for n=8 and n=9.
  let value = size >= 8 ? 0n : BigInt(bytes[offset] & (0xff >> size));
  for (let i = 1; i < size; i++) value = (value << 8n) | BigInt(bytes[offset + i]);
  return { value, size };
}

export function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let pos = 0;
  for (const p of parts) {
    out.set(p, pos);
    pos += p.length;
  }
  return out;
}

/** A length-prefixed UTF-8 string. */
export function encodeString(s: string): Uint8Array {
  const bytes = new TextEncoder().encode(s);
  return concat(encodeVarint(bytes.length), bytes);
}

/** A namespace tuple: field count, then each field as a string. */
export function encodeTuple(fields: readonly string[]): Uint8Array {
  return concat(encodeVarint(fields.length), ...fields.map(encodeString));
}

/** Buffered reader over a ReadableStream of bytes (a WebTransport stream). */
export class StreamReader {
  private buf = new Uint8Array(0);
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;

  constructor(stream: ReadableStream<Uint8Array>) {
    this.reader = stream.getReader();
  }

  async readBytes(n: number): Promise<Uint8Array> {
    while (this.buf.length < n) await this.fill();
    const out = this.buf.slice(0, n);
    this.buf = this.buf.slice(n);
    return out;
  }

  async readVarint(): Promise<bigint> {
    while (this.buf.length < 1) await this.fill();
    const size = varintSize(this.buf[0]);
    return decodeVarint(await this.readBytes(size)).value;
  }

  async readU16(): Promise<number> {
    const d = await this.readBytes(2);
    return (d[0] << 8) | d[1];
  }

  /** Stop reading; the stream is left for the transport to tear down. */
  release(): void {
    void this.reader.cancel().catch(() => {});
  }

  private async fill() {
    const { value, done } = await this.reader.read();
    if (done) throw new Error('stream ended');
    const next = new Uint8Array(this.buf.length + value.length);
    next.set(this.buf);
    next.set(value, this.buf.length);
    this.buf = next;
  }
}
