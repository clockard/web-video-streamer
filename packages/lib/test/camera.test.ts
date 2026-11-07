import { describe, expect, it } from 'vitest';
import { cameraFacing, isMissingCameraError, videoConstraints } from '../src/camera';

const device = (label: string, facingMode?: string[]) =>
  ({ kind: 'videoinput', deviceId: 'x', label, getCapabilities: facingMode ? () => ({ facingMode }) : undefined }) as unknown as MediaDeviceInfo;

describe('cameraFacing', () => {
  it('prefers reported capabilities, then the label', () => {
    expect(cameraFacing(device('camera2 0', ['environment']))).toBe('environment');
    expect(cameraFacing(device('Back Camera', ['user']))).toBe('user');
    expect(cameraFacing(device('Back Ultra Wide Camera'))).toBe('environment');
    expect(cameraFacing(device('camera 1, facing back'))).toBe('environment');
    expect(cameraFacing(device('Front Camera'))).toBe('user');
    expect(cameraFacing(device('FaceTime HD Camera'))).toBe('user');
    expect(cameraFacing(device('USB Webcam'))).toBeUndefined();
  });
});

describe('isMissingCameraError', () => {
  it('recognises a camera that no longer exists', () => {
    expect(isMissingCameraError({ name: 'OverconstrainedError', constraint: 'deviceId' })).toBe(true);
    expect(isMissingCameraError({ name: 'NotFoundError' })).toBe(true);
    expect(isMissingCameraError({ name: 'OverconstrainedError', constraint: 'width' })).toBe(false);
    expect(isMissingCameraError({ name: 'NotAllowedError' })).toBe(false);
  });
});

describe('videoConstraints', () => {
  it('uses the rear camera by default and an exact camera when given', () => {
    expect(videoConstraints({})).toMatchObject({ facingMode: { ideal: 'environment' }, width: { ideal: 1280 } });
    expect(videoConstraints({ facingMode: 'user' })).toMatchObject({ facingMode: { ideal: 'user' } });
    const exact = videoConstraints({ cameraId: 'abc', facingMode: 'user' });
    expect(exact).toMatchObject({ deviceId: { exact: 'abc' } });
    expect(exact).not.toHaveProperty('facingMode');
  });
});
