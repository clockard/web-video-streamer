export interface CameraOptions {
  width?: number;
  height?: number;
  fps?: number;
  /** 'environment' (rear, default) or 'user' (front). */
  facingMode?: 'environment' | 'user';
  /**
   * A specific camera's ID (from listCameras(), i.e. MediaDeviceInfo.deviceId); overrides facingMode.
   * If no such camera exists, the streamer warns and uses the default camera.
   */
  cameraId?: string;
}

/** Which camera to use: a specific one by ID, or by facing direction. Empty = the default (rear) camera. */
export interface CameraSelection {
  cameraId?: string;
  facingMode?: 'environment' | 'user';
}

export interface CameraInfo {
  /** Pass as `cameraId` / `setCamera({ cameraId })`. Stable per site across page loads. */
  id: string;
  /** e.g. "Back Ultra Wide Camera"; empty until camera permission has been granted. */
  label: string;
  /** Facing direction, when the browser reports it or the label makes it clear. */
  facing?: 'environment' | 'user';
}

/**
 * The device's cameras. Browsers hide camera IDs and labels until camera
 * permission is granted, so before that this may return an empty list (or
 * cameras without labels); call it again after streaming starts or on the
 * `devicechange` event of navigator.mediaDevices.
 */
export async function listCameras(): Promise<CameraInfo[]> {
  if (!navigator.mediaDevices?.enumerateDevices) return [];
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices
    .filter((d) => d.kind === 'videoinput' && d.deviceId)
    .map((d) => ({ id: d.deviceId, label: d.label, facing: cameraFacing(d) }));
}

/** Facing direction from the device's capabilities (Chromium) or, failing that, its label. */
export function cameraFacing(device: MediaDeviceInfo): 'environment' | 'user' | undefined {
  const caps = (device as MediaDeviceInfo & { getCapabilities?: () => { facingMode?: string[] } }).getCapabilities?.();
  const mode = caps?.facingMode?.find((m) => m === 'environment' || m === 'user');
  if (mode) return mode as 'environment' | 'user';
  if (/\b(back|rear|environment)\b/i.test(device.label)) return 'environment';
  if (/\b(front|user|facetime)\b/i.test(device.label)) return 'user';
  return undefined;
}

/** True for getUserMedia errors meaning the requested camera does not exist (any more). */
export function isMissingCameraError(err: unknown): boolean {
  const e = err as { name?: string; constraint?: string };
  return e?.name === 'NotFoundError' || (e?.name === 'OverconstrainedError' && (!e.constraint || e.constraint === 'deviceId'));
}

/**
 * Open the camera, and the microphone too when `audio` constraints are given.
 */
export async function openCamera(options: CameraOptions = {}, audio: MediaTrackConstraints | false = false): Promise<MediaStream> {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('Camera access is unavailable (a secure https:// context is required)');
  }
  return navigator.mediaDevices.getUserMedia({ audio, video: videoConstraints(options) });
}

/** getUserMedia video constraints for the requested camera, size and rate. */
export function videoConstraints(options: CameraOptions): MediaTrackConstraints {
  return {
    ...(options.cameraId ? { deviceId: { exact: options.cameraId } } : { facingMode: { ideal: options.facingMode ?? 'environment' } }),
    width: { ideal: options.width ?? 1280 },
    height: { ideal: options.height ?? 720 },
    frameRate: { ideal: options.fps ?? 30 },
  };
}

/** Current digital zoom factor of the track, where supported. */
export function trackZoom(track: MediaStreamTrack): number {
  const zoom = (track.getSettings() as MediaTrackSettings & { zoom?: number }).zoom;
  return typeof zoom === 'number' && zoom > 0 ? zoom : 1;
}

/** Human-readable camera label, used for the ST 0601 image source sensor tag. */
export function cameraLabel(track: MediaStreamTrack): string | undefined {
  return track.label || undefined;
}
