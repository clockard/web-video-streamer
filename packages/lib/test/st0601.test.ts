import { describe, expect, it } from 'vitest';
import misb from '@vidterra/misb.js';
import { berLength, checksum, encodeSt0601, ST0601_KEY, Tag } from '../src/klv/st0601';

const sample = {
  timestampUs: 1_761_800_000_123_456n,
  missionId: 'TEST',
  platformDesignation: 'Mobile Browser',
  imageSourceSensor: 'Pixel 9',
  platformHeading: 123.4,
  platformPitch: 0,
  platformRoll: 0,
  sensorLatitude: 38.8977,
  sensorLongitude: -77.0365,
  sensorTrueAltitude: 25.5,
  sensorEllipsoidHeight: -8.2,
  horizontalFov: 66.2,
  verticalFov: 39.4,
  sensorRelativeAzimuth: 0,
  sensorRelativeElevation: -12.5,
  sensorRelativeRoll: 358.2,
  slantRange: 8.64,
  frameCenterLatitude: 38.89,
  frameCenterLongitude: -77.035,
  corners: [
    { latitude: 38.901, longitude: -77.04 },
    { latitude: 38.902, longitude: -77.03 },
    { latitude: 38.8978, longitude: -77.0364 },
    { latitude: 38.8977, longitude: -77.0366 },
  ],
};

function parse(packet: Uint8Array) {
  const values = misb.st0601.parse(Buffer.from(packet)) as { key: number; value: unknown; valid?: boolean }[];
  return new Map(values.map((v) => [v.key, v]));
}

describe('encodeSt0601', () => {
  it('starts with the UAS Datalink LS key and ends with a valid checksum', () => {
    const packet = encodeSt0601(sample);
    expect(packet.subarray(0, 16)).toEqual(ST0601_KEY);
    const sum = (packet[packet.length - 2] << 8) | packet[packet.length - 1];
    expect(sum).toBe(checksum(packet));
    expect(packet[packet.length - 4]).toBe(Tag.Checksum);
  });

  it('round-trips through the misb.js parser', () => {
    const parsed = parse(encodeSt0601(sample));
    expect(parsed.get(Tag.Checksum)?.valid).not.toBe(false);
    expect(Number(parsed.get(Tag.PrecisionTimeStamp)?.value)).toBe(Number(sample.timestampUs));
    expect(parsed.get(Tag.MissionId)?.value).toBe('TEST');
    expect(parsed.get(Tag.PlatformDesignation)?.value).toBe('Mobile Browser');
    expect(parsed.get(Tag.ImageSourceSensor)?.value).toBe('Pixel 9');
    expect(parsed.get(Tag.PlatformHeading)?.value).toBeCloseTo(123.4, 2);
    expect(parsed.get(Tag.SensorLatitude)?.value).toBeCloseTo(38.8977, 6);
    expect(parsed.get(Tag.SensorLongitude)?.value).toBeCloseTo(-77.0365, 6);
    expect(parsed.get(Tag.SensorTrueAltitude)?.value).toBeCloseTo(25.5, 0);
    expect(parsed.get(Tag.SensorEllipsoidHeight)?.value).toBeCloseTo(-8.2, 0);
    expect(parsed.get(Tag.SensorHorizontalFov)?.value).toBeCloseTo(66.2, 2);
    expect(parsed.get(Tag.SensorVerticalFov)?.value).toBeCloseTo(39.4, 2);
    expect(parsed.get(Tag.SensorRelativeAzimuth)?.value).toBeCloseTo(0, 6);
    expect(parsed.get(Tag.SensorRelativeElevation)?.value).toBeCloseTo(-12.5, 6);
    expect(parsed.get(Tag.SensorRelativeRoll)?.value).toBeCloseTo(358.2, 6);
    expect(parsed.get(Tag.SlantRange)?.value).toBeCloseTo(8.64, 2);
    expect(parsed.get(Tag.FrameCenterLatitude)?.value).toBeCloseTo(38.89, 6);
    expect(parsed.get(Tag.FrameCenterLongitude)?.value).toBeCloseTo(-77.035, 6);
    sample.corners.forEach((c, i) => {
      expect(parsed.get(Tag.CornerLatitudePoint1Full + i * 2)?.value).toBeCloseTo(c.latitude, 6);
      expect(parsed.get(Tag.CornerLatitudePoint1Full + i * 2 + 1)?.value).toBeCloseTo(c.longitude, 6);
    });
    expect(parsed.get(Tag.UasLsVersion)?.value).toBe(17);
  });

  it('omits fields that are not provided', () => {
    const parsed = parse(encodeSt0601({ timestampUs: 1n }));
    expect([...parsed.keys()]).toEqual([Tag.PrecisionTimeStamp, Tag.UasLsVersion, Tag.Checksum]);
  });

  it('clamps out-of-range values and wraps angles', () => {
    const parsed = parse(encodeSt0601({ timestampUs: 1n, platformPitch: 45, platformHeading: -10 }));
    expect(parsed.get(Tag.PlatformPitch)?.value).toBeCloseTo(20, 2);
    expect(parsed.get(Tag.PlatformHeading)?.value).toBeCloseTo(350, 2);
  });
});

describe('berLength', () => {
  it('uses short and long forms', () => {
    expect([...berLength(5)]).toEqual([5]);
    expect([...berLength(127)]).toEqual([127]);
    expect([...berLength(128)]).toEqual([0x81, 128]);
    expect([...berLength(300)]).toEqual([0x82, 0x01, 0x2c]);
  });
});
