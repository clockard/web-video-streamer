/**
 * Ground footprint of the camera view.
 *
 * Rays through the image centre, corners and edges are intersected with a
 * flat ground plane a given height below the camera. Rays that point at or
 * above the horizon, or that hit the ground beyond `maxRange`, are cut off at
 * `maxRange` (horizontal distance) so the footprint stays finite.
 */
import type { CameraPose, Position } from './sensors';

export interface FootprintOptions {
  /** Camera height above the ground in metres (default 1.5, a hand-held phone). */
  heightAboveGround?: number;
  /** Horizontal distance limit in metres for rays that miss the ground or hit it far away (default 2000). */
  maxRange?: number;
  /** Points per image edge in the outline (default 8). */
  edgeSamples?: number;
}

export interface GroundPoint {
  latitude: number;
  longitude: number;
  /** Horizontal distance from the camera in metres. */
  distance: number;
  /** True when the ray was cut off at maxRange instead of hitting the ground. */
  capped: boolean;
}

export interface Footprint {
  /** Where the optical axis meets the ground. */
  center: GroundPoint;
  /** Straight-line distance from the camera to the frame centre, in metres. */
  slantRange: number;
  /** Image corners in ST 0601 order: upper-left, upper-right, lower-right, lower-left. */
  corners: [GroundPoint, GroundPoint, GroundPoint, GroundPoint];
  /** Closed outline along the image edges (clockwise from upper-left), for drawing. */
  outline: GroundPoint[];
  /** True when any part of the view is cut off at maxRange. */
  capped: boolean;
}

type Vec3 = [number, number, number];

const EARTH_RADIUS_M = 6_371_008.8;
const rad = (d: number) => (d * Math.PI) / 180;
const deg = (r: number) => (r * 180) / Math.PI;

/** Camera axes in the local East-North-Up frame. */
export function cameraAxes(pose: Pick<CameraPose, 'azimuth' | 'elevation' | 'roll'>) {
  const [sa, ca] = [Math.sin(rad(pose.azimuth)), Math.cos(rad(pose.azimuth))];
  const [se, ce] = [Math.sin(rad(pose.elevation)), Math.cos(rad(pose.elevation))];
  const [sr, cr] = [Math.sin(rad(pose.roll)), Math.cos(rad(pose.roll))];
  const forward: Vec3 = [sa * ce, ca * ce, se];
  // Image up and right before roll: up tilts with elevation, right stays level.
  const up0: Vec3 = [-sa * se, -ca * se, ce];
  const right0: Vec3 = [ca, -sa, 0];
  // Positive roll turns the image clockwise as seen from behind the camera.
  const up: Vec3 = [up0[0] * cr + right0[0] * sr, up0[1] * cr + right0[1] * sr, up0[2] * cr + right0[2] * sr];
  const right: Vec3 = [right0[0] * cr - up0[0] * sr, right0[1] * cr - up0[1] * sr, right0[2] * cr - up0[2] * sr];
  return { forward, up, right };
}

/** Offset a position by east/north metres (local flat-earth approximation, fine for a few km). */
function offset(position: Position, east: number, north: number) {
  return {
    latitude: position.latitude + deg(north / EARTH_RADIUS_M),
    longitude: position.longitude + deg(east / (EARTH_RADIUS_M * Math.cos(rad(position.latitude)))),
  };
}

export function computeFootprint(
  position: Position,
  pose: Pick<CameraPose, 'azimuth' | 'elevation' | 'roll'>,
  fov: { horizontal: number; vertical: number },
  options: FootprintOptions = {},
): Footprint {
  const height = Math.max(0.01, options.heightAboveGround ?? 1.5);
  const maxRange = options.maxRange ?? 2000;
  const samples = Math.max(1, options.edgeSamples ?? 8);
  const { forward, up, right } = cameraAxes(pose);
  const tx = Math.tan(rad(fov.horizontal) / 2);
  const ty = Math.tan(rad(fov.vertical) / 2);

  /** Ground hit for normalised image coordinates x (right) and y (up) in [-1, 1]. */
  const ray = (x: number, y: number) => {
    const d: Vec3 = [0, 1, 2].map((i) => forward[i] + x * tx * right[i] + y * ty * up[i]) as Vec3;
    const horizontal = Math.hypot(d[0], d[1]);
    let t = d[2] < 0 ? height / -d[2] : Infinity; // ray parameter where it reaches the ground
    let capped = false;
    if (t * horizontal > maxRange) {
      capped = true;
      t = horizontal > 1e-9 ? maxRange / horizontal : 0;
    }
    const east = t * d[0];
    const north = t * d[1];
    const point: GroundPoint = { ...offset(position, east, north), distance: Math.hypot(east, north), capped };
    const slant = capped ? Math.hypot(east, north, height) : t * Math.hypot(...d);
    return { point, slant };
  };

  const center = ray(0, 0);
  const corners = (
    [
      [-1, 1],
      [1, 1],
      [1, -1],
      [-1, -1],
    ] as const
  ).map(([x, y]) => ray(x, y).point) as Footprint['corners'];

  // Walk the image border clockwise: top edge, right edge, bottom edge, left edge.
  const outline: GroundPoint[] = [];
  const edges: [number, number, number, number][] = [
    [-1, 1, 1, 1],
    [1, 1, 1, -1],
    [1, -1, -1, -1],
    [-1, -1, -1, 1],
  ];
  for (const [x0, y0, x1, y1] of edges) {
    for (let i = 0; i < samples; i++) {
      const f = i / samples;
      outline.push(ray(x0 + (x1 - x0) * f, y0 + (y1 - y0) * f).point);
    }
  }

  return {
    center: center.point,
    slantRange: center.slant,
    corners,
    outline,
    capped: outline.some((p) => p.capped) || center.point.capped,
  };
}
