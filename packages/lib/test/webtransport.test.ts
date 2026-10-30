import { describe, expect, it } from 'vitest';
import { chunkForDatagrams } from '../src/webtransport';

describe('chunkForDatagrams', () => {
  it('splits on TS packet boundaries within the datagram size', () => {
    const data = new Uint8Array(20 * 188);
    const chunks = chunkForDatagrams(data, 1200); // 6 packets fit in 1200 bytes
    expect(chunks.map((c) => c.length)).toEqual([1128, 1128, 1128, 376]);
  });

  it('sends small writes as one datagram', () => {
    expect(chunkForDatagrams(new Uint8Array(2 * 188), 1200).map((c) => c.length)).toEqual([376]);
  });

  it('never goes below one packet per datagram', () => {
    expect(chunkForDatagrams(new Uint8Array(2 * 188), 100).map((c) => c.length)).toEqual([188, 188]);
  });
});
