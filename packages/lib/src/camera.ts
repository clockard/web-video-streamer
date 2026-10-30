export interface CameraOptions {
  width?: number;
  height?: number;
  fps?: number;
  /** 'environment' (rear, default) or 'user' (front), or a specific deviceId. */
  facingMode?: 'environment' | 'user';
  deviceId?: string;
}

export async function openCamera(options: CameraOptions = {}): Promise<MediaStream> {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('Camera access is unavailable (a secure https:// context is required)');
  }
  return navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      ...(options.deviceId ? { deviceId: { exact: options.deviceId } } : { facingMode: { ideal: options.facingMode ?? 'environment' } }),
      width: { ideal: options.width ?? 1280 },
      height: { ideal: options.height ?? 720 },
      frameRate: { ideal: options.fps ?? 30 },
    },
  });
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
