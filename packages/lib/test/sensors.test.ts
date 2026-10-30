import { describe, expect, it } from 'vitest';
import { cameraPose, rotationMatrix, type Mat3 } from '../src/sensors';

/** Build a device-to-world matrix from where the device x, y, z axes point (East, North, Up). */
const fromAxes = (x: number[], y: number[], z: number[]): Mat3 => [
  [x[0], y[0], z[0]],
  [x[1], y[1], z[1]],
  [x[2], y[2], z[2]],
];

const angleClose = (actual: number, expected: number) => {
  const diff = ((actual - expected + 540) % 360) - 180;
  expect(Math.abs(diff)).toBeLessThan(1e-6);
};

describe('rotationMatrix', () => {
  it('is identity for zero angles and orthonormal otherwise', () => {
    expect(rotationMatrix(0, 0, 0).flat().map((v) => Math.round(v * 1e9) / 1e9 + 0)).toEqual([1, 0, 0, 0, 1, 0, 0, 0, 1]);
    const r = rotationMatrix(33, 47, -12);
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) {
        const d = r[0][i] * r[0][j] + r[1][i] * r[1][j] + r[2][i] * r[2][j];
        expect(d).toBeCloseTo(i === j ? 1 : 0, 9);
      }
    }
  });
});

describe('cameraPose', () => {
  it('upright portrait phone facing north', () => {
    const p = cameraPose(rotationMatrix(0, 90, 0));
    angleClose(p.azimuth, 0);
    expect(p.elevation).toBeCloseTo(0, 6);
    angleClose(p.roll, 0);
  });

  it('turning left (alpha increases counter-clockwise) faces west', () => {
    angleClose(cameraPose(rotationMatrix(90, 90, 0)).azimuth, 270);
    angleClose(cameraPose(rotationMatrix(270, 90, 0)).azimuth, 90);
  });

  it('tilting the top of the phone back points the camera down', () => {
    const p = cameraPose(rotationMatrix(0, 60, 0));
    expect(p.elevation).toBeCloseTo(-30, 6);
    angleClose(p.azimuth, 0);
    angleClose(p.roll, 0);
  });

  it('flat on a table, screen up, looks straight down with top-of-phone azimuth', () => {
    const p = cameraPose(rotationMatrix(0, 0, 0));
    expect(p.elevation).toBeCloseTo(-90, 6);
    angleClose(p.azimuth, 0);
  });

  it('landscape (rotated counter-clockwise) facing north has zero roll when the screen follows', () => {
    // Device x points up, y points west, z (screen) points south towards the user.
    const r = fromAxes([0, 0, 1], [-1, 0, 0], [0, -1, 0]);
    const p = cameraPose(r, 90);
    angleClose(p.azimuth, 0);
    expect(p.elevation).toBeCloseTo(0, 6);
    angleClose(p.roll, 0);
    // With rotation lock the image stays portrait, so it is rolled 90° counter-clockwise.
    angleClose(cameraPose(r, 0).roll, 270);
  });

  it('a small clockwise twist gives a small positive roll', () => {
    // Portrait facing north, rotated 10° clockwise as seen from behind the camera.
    const t = (10 * Math.PI) / 180;
    const r = fromAxes([Math.cos(t), 0, -Math.sin(t)], [Math.sin(t), 0, Math.cos(t)], [0, -1, 0]);
    angleClose(cameraPose(r).roll, 10);
  });
});
