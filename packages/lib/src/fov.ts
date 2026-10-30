/**
 * Camera field-of-view estimation from photo EXIF data.
 *
 * Phones record FocalLengthIn35mmFilm, the focal length giving the same
 * diagonal angle of view on a 36x24 mm frame. From it and the photo aspect
 * ratio we derive the photo's horizontal/vertical FOV, then adjust for the
 * video frame, which is usually a crop of the sensor (e.g. 16:9 from 4:3).
 */
// Lite build: JPEG/HEIC EXIF parsing only, much smaller than the full bundle.
import exifr from 'exifr/dist/lite.esm.mjs';

export type FovSource = 'override' | 'photo-exif' | 'image-capture-exif' | 'default';

export interface FovResult {
  /** Degrees across the video frame's width. */
  horizontal: number;
  /** Degrees across the video frame's height. */
  vertical: number;
  source: FovSource;
  focalLength35mm?: number;
  focalLength?: number;
  make?: string;
  model?: string;
}

export interface PhotoInfo {
  focalLength35mm?: number;
  focalLength?: number;
  make?: string;
  model?: string;
  width?: number;
  height?: number;
}

/** Typical main (1x) phone camera when no EXIF data is available. */
export const DEFAULT_FOCAL_LENGTH_35MM = 26;
const FULL_FRAME_DIAGONAL_MM = Math.hypot(36, 24);
const DEFAULT_PHOTO_ASPECT = 4 / 3;

const deg = (rad: number) => (rad * 180) / Math.PI;
const rad = (d: number) => (d * Math.PI) / 180;

/**
 * Horizontal and vertical FOV of a photo in landscape orientation.
 * @param aspect long side / short side of the photo
 */
export function photoFov(focalLength35mm: number, aspect = DEFAULT_PHOTO_ASPECT) {
  // The 35mm equivalent is defined on the diagonal, so split the 43.27 mm
  // full-frame diagonal according to the photo's own aspect ratio.
  const width = (FULL_FRAME_DIAGONAL_MM * aspect) / Math.hypot(aspect, 1);
  const height = width / aspect;
  return {
    horizontal: deg(2 * Math.atan(width / (2 * focalLength35mm))),
    vertical: deg(2 * Math.atan(height / (2 * focalLength35mm))),
  };
}

/**
 * FOV of a video frame captured by the same sensor, assuming the video is the
 * largest centred crop of the photo frame with the video's aspect ratio.
 */
export function videoFov(
  photo: { horizontal: number; vertical: number },
  videoWidth: number,
  videoHeight: number,
  zoom = 1,
): { horizontal: number; vertical: number } {
  const portrait = videoHeight > videoWidth;
  const videoAspect = Math.max(videoWidth, videoHeight) / Math.min(videoWidth, videoHeight);
  let tanH = Math.tan(rad(photo.horizontal) / 2) / zoom;
  let tanV = Math.tan(rad(photo.vertical) / 2) / zoom;
  if (videoAspect >= tanH / tanV) tanV = tanH / videoAspect; // wider video: crop top/bottom
  else tanH = tanV * videoAspect; // narrower video: crop the sides
  const long = deg(2 * Math.atan(tanH));
  const short = deg(2 * Math.atan(tanV));
  return portrait ? { horizontal: short, vertical: long } : { horizontal: long, vertical: short };
}

const EXIF = {
  ImageWidth: 0x0100,
  ImageHeight: 0x0101,
  Make: 0x010f,
  Model: 0x0110,
  FocalLength: 0x920a,
  ExifImageWidth: 0xa002,
  ExifImageHeight: 0xa003,
  FocalLengthIn35mmFilm: 0xa405,
} as const;

/** Read the EXIF fields relevant to FOV from a JPEG/HEIC photo. */
export async function readPhotoInfo(photo: Blob | ArrayBuffer | Uint8Array): Promise<PhotoInfo> {
  // The lite build has no tag-name dictionaries, so read untranslated numeric tag IDs.
  const tags: Record<number, unknown> | undefined = await exifr.parse(photo, {
    exif: true,
    gps: false,
    interop: false,
    ifd1: false,
    translateKeys: false,
    translateValues: false,
    reviveValues: false,
    mergeOutput: true,
  });
  if (!tags) return {};
  const num = (tag: number) => (typeof tags[tag] === 'number' && (tags[tag] as number) > 0 ? (tags[tag] as number) : undefined);
  const str = (tag: number) => (typeof tags[tag] === 'string' ? (tags[tag] as string).trim() || undefined : undefined);
  return {
    focalLength35mm: num(EXIF.FocalLengthIn35mmFilm),
    focalLength: num(EXIF.FocalLength),
    make: str(EXIF.Make),
    model: str(EXIF.Model),
    width: num(EXIF.ExifImageWidth) ?? num(EXIF.ImageWidth),
    height: num(EXIF.ExifImageHeight) ?? num(EXIF.ImageHeight),
  };
}

/** Build a FOV result for a video frame from photo metadata (or defaults). */
export function fovFromPhotoInfo(
  info: PhotoInfo,
  videoWidth: number,
  videoHeight: number,
  source: FovSource,
  zoom = 1,
): FovResult {
  const f35 = info.focalLength35mm ?? DEFAULT_FOCAL_LENGTH_35MM;
  const aspect =
    info.width && info.height ? Math.max(info.width, info.height) / Math.min(info.width, info.height) : DEFAULT_PHOTO_ASPECT;
  return {
    ...videoFov(photoFov(f35, aspect), videoWidth, videoHeight, zoom),
    source: info.focalLength35mm ? source : 'default',
    focalLength35mm: f35,
    focalLength: info.focalLength,
    make: info.make,
    model: info.model,
  };
}

/** Take a still with the ImageCapture API (Chromium only) from the live camera track. */
export async function takePhotoWithImageCapture(track: MediaStreamTrack): Promise<Blob | null> {
  const ImageCaptureCtor = (globalThis as { ImageCapture?: new (t: MediaStreamTrack) => { takePhoto(): Promise<Blob> } })
    .ImageCapture;
  if (!ImageCaptureCtor) return null;
  try {
    return await new ImageCaptureCtor(track).takePhoto();
  } catch {
    return null;
  }
}

/**
 * Open the device's native camera app and resolve with the photo taken.
 * Native photos keep their lens EXIF data, unlike in-page captures.
 *
 * Must be called synchronously from a user gesture (e.g. a click handler).
 * Resolves with null if the user cancels.
 */
export function capturePhotoWithNativeCamera(): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.setAttribute('capture', 'environment');
    input.style.display = 'none';
    const finish = (file: File | null) => {
      input.remove();
      resolve(file);
    };
    input.addEventListener('change', () => finish(input.files?.[0] ?? null), { once: true });
    input.addEventListener('cancel', () => finish(null), { once: true });
    document.body.append(input);
    input.click();
  });
}
