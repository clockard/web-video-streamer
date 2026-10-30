/** CRC-32/MPEG-2 (poly 0x04C11DB7, init 0xFFFFFFFF, no reflection, no final XOR) used by PSI sections. */
const TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i << 24;
    for (let k = 0; k < 8; k++) c = c & 0x80000000 ? (c << 1) ^ 0x04c11db7 : c << 1;
    table[i] = c >>> 0;
  }
  return table;
})();

export function crc32Mpeg(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) crc = ((crc << 8) ^ TABLE[((crc >>> 24) ^ byte) & 0xff]) >>> 0;
  return crc >>> 0;
}
