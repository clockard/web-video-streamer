import { describe, expect, it } from 'vitest';
import { fovFromPhotoInfo, photoFov, videoFov } from '../src/fov';

describe('photoFov', () => {
  it('matches the full-frame definition for a 3:2 frame', () => {
    // 50 mm on 36x24: 39.6° x 27.0°
    const fov = photoFov(50, 3 / 2);
    expect(fov.horizontal).toBeCloseTo(39.6, 1);
    expect(fov.vertical).toBeCloseTo(27.0, 1);
  });

  it('gives typical phone main-camera values for 26 mm at 4:3', () => {
    // Diagonal 2*atan(43.27/52) = 79.5°; 34.6 x 26.0 mm at 4:3
    const { horizontal, vertical } = photoFov(26, 4 / 3);
    expect(horizontal).toBeCloseTo(67.3, 1);
    expect(vertical).toBeCloseTo(53.1, 1);
  });
});

describe('videoFov', () => {
  const photo = photoFov(26, 4 / 3);

  it('keeps the horizontal FOV and crops vertically for 16:9 landscape video', () => {
    const v = videoFov(photo, 1920, 1080);
    expect(v.horizontal).toBeCloseTo(photo.horizontal, 6);
    expect(v.vertical).toBeCloseTo(41.1, 1);
  });

  it('swaps axes for portrait video', () => {
    const v = videoFov(photo, 1080, 1920);
    expect(v.vertical).toBeCloseTo(photo.horizontal, 6);
    expect(v.horizontal).toBeCloseTo(41.1, 1);
  });

  it('crops the sides when the video is narrower than the photo', () => {
    const wide = photoFov(26, 16 / 9);
    const v = videoFov(wide, 640, 480);
    expect(v.vertical).toBeCloseTo(wide.vertical, 6);
    expect(v.horizontal).toBeLessThan(wide.horizontal);
  });

  it('narrows with zoom', () => {
    const v = videoFov(photo, 1280, 720, 2);
    const unzoomed = videoFov(photo, 1280, 720);
    const ratio = Math.tan((v.horizontal * Math.PI) / 360) / Math.tan((unzoomed.horizontal * Math.PI) / 360);
    expect(ratio).toBeCloseTo(0.5, 6);
  });
});

describe('fovFromPhotoInfo', () => {
  it('uses EXIF focal length and photo aspect', () => {
    const r = fovFromPhotoInfo({ focalLength35mm: 26, width: 4032, height: 3024, model: 'iPhone' }, 1280, 720, 'photo-exif');
    expect(r.source).toBe('photo-exif');
    expect(r.horizontal).toBeCloseTo(67.3, 1);
    expect(r.model).toBe('iPhone');
  });

  it('falls back to defaults without EXIF', () => {
    const r = fovFromPhotoInfo({}, 1280, 720, 'image-capture-exif');
    expect(r.source).toBe('default');
    expect(r.focalLength35mm).toBe(26);
  });
});
