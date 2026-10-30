import { describe, expect, it } from 'vitest';
import { readPhotoInfo } from '../src/fov';

/** Build a minimal big-endian EXIF JPEG with the tags a phone camera writes. */
function jpegWithExif(): Uint8Array {
  const tiff: number[] = [];
  const u16 = (v: number) => [(v >> 8) & 0xff, v & 0xff];
  const u32 = (v: number) => [...u16(v >>> 16), ...u16(v & 0xffff)];
  const entry = (tag: number, type: number, count: number, value: number[]) => [
    ...u16(tag), ...u16(type), ...u32(count), ...value, ...new Array(4 - value.length).fill(0),
  ];
  const make = [...new TextEncoder().encode('Google'), 0];
  const model = [...new TextEncoder().encode('Pixel 9'), 0];

  const ifd0At = 8;
  const ifd0Size = 2 + 3 * 12 + 4;
  const exifAt = ifd0At + ifd0Size;
  const exifSize = 2 + 4 * 12 + 4;
  const dataAt = exifAt + exifSize;
  const makeAt = dataAt;
  const modelAt = makeAt + make.length;
  const focalAt = modelAt + model.length;

  tiff.push(0x4d, 0x4d, ...u16(42), ...u32(ifd0At));
  tiff.push(...u16(3));
  tiff.push(...entry(0x010f, 2, make.length, u32(makeAt)));
  tiff.push(...entry(0x0110, 2, model.length, u32(modelAt)));
  tiff.push(...entry(0x8769, 4, 1, u32(exifAt)));
  tiff.push(...u32(0));
  tiff.push(...u16(4));
  tiff.push(...entry(0x920a, 5, 1, u32(focalAt))); // FocalLength (rational)
  tiff.push(...entry(0xa002, 4, 1, u32(4080))); // ExifImageWidth
  tiff.push(...entry(0xa003, 4, 1, u32(3072))); // ExifImageHeight
  tiff.push(...entry(0xa405, 3, 1, u16(25))); // FocalLengthIn35mmFilm
  tiff.push(...u32(0));
  tiff.push(...make, ...model, ...u32(690), ...u32(100));

  const app1 = [...new TextEncoder().encode('Exif'), 0, 0, ...tiff];
  return new Uint8Array([0xff, 0xd8, 0xff, 0xe1, ...u16(app1.length + 2), ...app1, 0xff, 0xd9]);
}

describe('readPhotoInfo', () => {
  it('extracts focal lengths, camera and image size from EXIF', async () => {
    const info = await readPhotoInfo(jpegWithExif());
    expect(info).toEqual({
      focalLength35mm: 25,
      focalLength: 6.9,
      make: 'Google',
      model: 'Pixel 9',
      width: 4080,
      height: 3072,
    });
  });

  it('returns an empty result for images without EXIF', async () => {
    expect(await readPhotoInfo(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]))).toEqual({});
  });
});
