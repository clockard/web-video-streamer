/**
 * Device location and rear-camera pointing direction.
 *
 * World frame: x = East, y = North, z = Up. Device frame (W3C): x to the right
 * of the screen, y towards the top of the screen, z out of the screen. The
 * rear camera looks along device -z.
 */

export type Vec3 = [number, number, number];
export type Mat3 = [Vec3, Vec3, Vec3];

export interface Position {
  latitude: number;
  longitude: number;
  /** Metres above the WGS84 ellipsoid, if known. */
  altitude?: number;
  accuracy: number;
  timestamp: number;
}

export interface CameraPose {
  /** Degrees clockwise from north, 0..360. */
  azimuth: number;
  /** Degrees above the horizon, -90..90. */
  elevation: number;
  /** Degrees clockwise rotation of the image about the optical axis, 0..360. */
  roll: number;
  /** True when the heading is referenced to north (absolute sensor or compass). */
  absolute: boolean;
}

const rad = (d: number) => (d * Math.PI) / 180;
const deg = (r: number) => (r * 180) / Math.PI;
const wrap360 = (d: number) => ((d % 360) + 360) % 360;
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const mul = (m: Mat3, v: Vec3): Vec3 => [dot(m[0], v), dot(m[1], v), dot(m[2], v)];

/** Device-to-world rotation from DeviceOrientationEvent angles (intrinsic Z-X'-Y''). */
export function rotationMatrix(alpha: number, beta: number, gamma: number): Mat3 {
  const [cA, sA] = [Math.cos(rad(alpha)), Math.sin(rad(alpha))];
  const [cB, sB] = [Math.cos(rad(beta)), Math.sin(rad(beta))];
  const [cG, sG] = [Math.cos(rad(gamma)), Math.sin(rad(gamma))];
  return [
    [cA * cG - sA * sB * sG, -cB * sA, cG * sA * sB + cA * sG],
    [cG * sA + cA * sB * sG, cA * cB, sA * sG - cA * cG * sB],
    [-cB * sG, sB, cB * cG],
  ];
}

/**
 * Pose of the rear camera given the device rotation and the screen orientation
 * angle (video frames are rotated to match the screen, so "up" in the image
 * follows the screen).
 */
export function cameraPose(r: Mat3, screenAngle = 0, absolute = true): CameraPose {
  const forward = mul(r, [0, 0, -1]);
  const theta = rad(screenAngle);
  const up = mul(r, [Math.sin(theta), Math.cos(theta), 0]);

  const elevation = deg(Math.asin(Math.max(-1, Math.min(1, forward[2]))));
  // Near straight up/down the azimuth is undefined; use the image's up direction instead.
  const horiz = Math.hypot(forward[0], forward[1]) > 1e-3 ? forward : forward[2] < 0 ? up : ([-up[0], -up[1], 0] as Vec3);
  const azimuth = wrap360(deg(Math.atan2(horiz[0], horiz[1])));

  // Roll: angle from the level "up" in the image plane to the image's actual up,
  // positive clockwise when looking along the optical axis.
  const worldUp: Vec3 = [0, 0, 1];
  const levelUp = cross(cross(forward, worldUp), forward);
  const roll = Math.hypot(...levelUp) < 1e-6 ? 0 : deg(Math.atan2(dot(cross(levelUp, up), forward), dot(levelUp, up)));

  return { azimuth, elevation, roll: wrap360(roll), absolute };
}

interface OrientationReading {
  alpha: number;
  beta: number;
  gamma: number;
  absolute: boolean;
}

type IosOrientationEvent = DeviceOrientationEvent & { webkitCompassHeading?: number };
type PermissionRequester = { requestPermission?: () => Promise<'granted' | 'denied'> };

/**
 * Request motion/orientation permission on iOS. Must be called synchronously
 * from a user gesture; resolves true where no permission is needed.
 */
export function requestOrientationPermission(): Promise<boolean> {
  const ctors = [globalThis.DeviceOrientationEvent, globalThis.DeviceMotionEvent] as unknown as PermissionRequester[];
  const requests = ctors.filter((c) => typeof c?.requestPermission === 'function').map((c) => c.requestPermission!());
  if (!requests.length) return Promise.resolve(true);
  return Promise.all(requests).then(
    (results) => results.every((r) => r === 'granted'),
    () => false,
  );
}

export interface SensorOptions {
  /** Added to magnetic headings to convert to true north (degrees, east positive). */
  declination?: number;
}

/** Tracks the latest position and camera pose. */
export class SensorTracker {
  position?: Position;
  private orientation?: OrientationReading;
  private watchId?: number;
  private readonly declination: number;
  private readonly cleanups: (() => void)[] = [];

  constructor(options: SensorOptions = {}) {
    this.declination = options.declination ?? 0;
  }

  start(onError?: (err: Error) => void): void {
    if ('geolocation' in navigator) {
      this.watchId = navigator.geolocation.watchPosition(
        (p) => {
          this.position = {
            latitude: p.coords.latitude,
            longitude: p.coords.longitude,
            altitude: p.coords.altitude ?? undefined,
            accuracy: p.coords.accuracy,
            timestamp: p.timestamp,
          };
        },
        (err) => onError?.(new Error(`geolocation: ${err.message}`)),
        { enableHighAccuracy: true, maximumAge: 1000 },
      );
    }

    // Prefer Chrome's absolute (north-referenced) event; fall back to the
    // regular event with iOS's webkitCompassHeading.
    let sawAbsolute = false;
    const onAbsolute = (e: DeviceOrientationEvent) => {
      if (e.alpha === null || e.beta === null || e.gamma === null) return;
      sawAbsolute = true;
      this.orientation = { alpha: e.alpha, beta: e.beta, gamma: e.gamma, absolute: true };
    };
    const onRelative = (e: IosOrientationEvent) => {
      if (sawAbsolute || e.beta === null || e.gamma === null) return;
      if (typeof e.webkitCompassHeading === 'number') {
        // iOS: alpha has an arbitrary origin; the compass heading is degrees clockwise from magnetic north.
        this.orientation = { alpha: 360 - e.webkitCompassHeading, beta: e.beta, gamma: e.gamma, absolute: true };
      } else if (e.alpha !== null) {
        this.orientation = { alpha: e.alpha, beta: e.beta, gamma: e.gamma, absolute: e.absolute };
      }
    };
    this.listen('deviceorientationabsolute', onAbsolute as EventListener);
    this.listen('deviceorientation', onRelative as EventListener);
  }

  stop(): void {
    if (this.watchId !== undefined) navigator.geolocation.clearWatch(this.watchId);
    this.watchId = undefined;
    this.cleanups.splice(0).forEach((fn) => fn());
  }

  /** Current camera pose, or undefined if no orientation sensor has reported. */
  pose(): CameraPose | undefined {
    const o = this.orientation;
    if (!o) return undefined;
    const pose = cameraPose(rotationMatrix(o.alpha, o.beta, o.gamma), screenAngle(), o.absolute);
    if (o.absolute) pose.azimuth = wrap360(pose.azimuth + this.declination);
    return pose;
  }

  private listen(type: string, fn: EventListener) {
    window.addEventListener(type, fn);
    this.cleanups.push(() => window.removeEventListener(type, fn));
  }
}

function screenAngle(): number {
  return screen.orientation?.angle ?? (window as { orientation?: number }).orientation ?? 0;
}
