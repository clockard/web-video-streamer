import { describe, expect, it } from 'vitest';
import { cameraAxes, computeFootprint } from '../src/footprint';
import { cameraPose, rotationMatrix } from '../src/sensors';

const origin = { latitude: 38.8895, longitude: -77.0353, accuracy: 5, timestamp: 0 };
const fov = { horizontal: 60, vertical: 40 };
const M_PER_DEG_LAT = (6_371_008.8 * Math.PI) / 180;

/** East/north metres of a ground point from the origin. */
const en = (p: { latitude: number; longitude: number }) => [
  (p.longitude - origin.longitude) * M_PER_DEG_LAT * Math.cos((origin.latitude * Math.PI) / 180),
  (p.latitude - origin.latitude) * M_PER_DEG_LAT,
];

describe('cameraAxes', () => {
  it('agrees with the sensor model: image up follows the device for any pose', () => {
    for (const [alpha, beta, gamma, screen] of [
      [0, 90, 0, 0],
      [33, 70, -12, 0],
      [200, 45, 20, 90],
      [300, 100, 5, 270],
    ]) {
      const r = rotationMatrix(alpha, beta, gamma);
      const pose = cameraPose(r, screen);
      const { forward, up } = cameraAxes(pose);
      const t = (screen * Math.PI) / 180;
      const deviceUp = [0, 1, 2].map((i) => r[i][0] * Math.sin(t) + r[i][1] * Math.cos(t));
      const deviceForward = [0, 1, 2].map((i) => -r[i][2]);
      for (let i = 0; i < 3; i++) {
        expect(forward[i]).toBeCloseTo(deviceForward[i], 6);
        expect(up[i]).toBeCloseTo(deviceUp[i], 6);
      }
    }
  });
});

describe('computeFootprint', () => {
  it('puts the frame centre where a tilted-down camera meets the ground', () => {
    // 1.5 m high, looking north-east 10° below the horizon.
    const f = computeFootprint(origin, { azimuth: 45, elevation: -10, roll: 0 }, fov, { heightAboveGround: 1.5 });
    const ground = 1.5 / Math.tan((10 * Math.PI) / 180);
    expect(f.center.distance).toBeCloseTo(ground, 3);
    expect(f.slantRange).toBeCloseTo(1.5 / Math.sin((10 * Math.PI) / 180), 3);
    const [e, n] = en(f.center);
    expect(e).toBeCloseTo(ground * Math.SQRT1_2, 1);
    expect(n).toBeCloseTo(ground * Math.SQRT1_2, 1);
    expect(f.center.capped).toBe(false);
  });

  it('caps rays at and above the horizon at maxRange', () => {
    // Top of the view is 10° above the horizon; the bottom edge reaches the ground.
    const f = computeFootprint(origin, { azimuth: 0, elevation: -10, roll: 0 }, fov, { maxRange: 500 });
    const [ul, ur, lr, ll] = f.corners;
    expect(ul.capped && ur.capped).toBe(true);
    expect(ul.distance).toBeCloseTo(500, 3);
    expect(lr.capped || ll.capped).toBe(false);
    expect(f.capped).toBe(true);
  });

  it('caps the frame centre when looking at the horizon', () => {
    const f = computeFootprint(origin, { azimuth: 90, elevation: 0, roll: 0 }, fov, { maxRange: 1000, heightAboveGround: 2 });
    expect(f.center.capped).toBe(true);
    expect(f.center.distance).toBeCloseTo(1000, 3);
    expect(f.slantRange).toBeCloseTo(Math.hypot(1000, 2), 3);
    const [e, n] = en(f.center);
    expect(e).toBeCloseTo(1000, 0);
    expect(n).toBeCloseTo(0, 0);
  });

  it('is a rectangle centred under a camera looking straight down', () => {
    const f = computeFootprint(origin, { azimuth: 0, elevation: -90, roll: 0 }, fov, { heightAboveGround: 10 });
    expect(f.center.distance).toBeCloseTo(0, 6);
    expect(f.slantRange).toBeCloseTo(10, 6);
    const halfW = 10 * Math.tan((30 * Math.PI) / 180);
    const halfH = 10 * Math.tan((20 * Math.PI) / 180);
    // Looking down with the image top towards north: upper-left is north-west.
    const [e, n] = en(f.corners[0]);
    expect(e).toBeCloseTo(-halfW, 2);
    expect(n).toBeCloseTo(halfH, 2);
  });

  it('rotates the footprint with roll', () => {
    const level = computeFootprint(origin, { azimuth: 0, elevation: -90, roll: 0 }, fov, { heightAboveGround: 10 });
    const rolled = computeFootprint(origin, { azimuth: 0, elevation: -90, roll: 90 }, fov, { heightAboveGround: 10 });
    // A 90° clockwise roll looking down swaps the footprint's long axis from east-west to north-south.
    const span = (f: typeof level) => {
      const pts = f.corners.map(en);
      return [Math.max(...pts.map((p) => p[0])) - Math.min(...pts.map((p) => p[0])), Math.max(...pts.map((p) => p[1])) - Math.min(...pts.map((p) => p[1]))];
    };
    const [we, wn] = span(level);
    const [re, rn] = span(rolled);
    expect(we).toBeGreaterThan(wn);
    expect(rn).toBeCloseTo(we, 3);
    expect(re).toBeCloseTo(wn, 3);
  });

  it('samples a closed outline around the image border', () => {
    const f = computeFootprint(origin, { azimuth: 0, elevation: -30, roll: 0 }, fov, { edgeSamples: 4 });
    expect(f.outline).toHaveLength(16);
    expect(f.outline[0]).toEqual(f.corners[0]);
    expect(f.outline[4]).toEqual(f.corners[1]);
    expect(f.outline[8]).toEqual(f.corners[2]);
    expect(f.outline[12]).toEqual(f.corners[3]);
  });
});
