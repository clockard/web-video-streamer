import { describe, expect, it } from 'vitest';
import { FramePacer } from '../src/pacer';

/** Runs frame timestamps (ms) through a pacer; returns the accepted ones. */
function pace(fps: number, timesMs: number[]): number[] {
  const pacer = new FramePacer(fps);
  return timesMs.filter((t) => pacer.accept(t * 1000));
}

const range = (n: number, f: (i: number) => number) => Array.from({ length: n }, (_, i) => f(i));

describe('FramePacer', () => {
  it('keeps every frame of a camera already at the target rate, even when snapped to vsync', () => {
    // 10 fps frames as requestVideoFrameCallback reports them at 60 Hz: each
    // lands on the next 16.7 ms tick, plus a random 0–2 tick render delay.
    const vsync = 1000 / 60;
    let seed = 1;
    const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const times = range(100, (i) => Math.ceil((i * 100) / vsync + Math.floor(rand() * 3)) * vsync);
    expect(pace(10, times)).toHaveLength(100);
  });

  it('caps a faster camera at the target rate', () => {
    const accepted = pace(10, range(300, (i) => (i * 1000) / 30)); // 10 s at 30 fps
    expect(accepted.length).toBeGreaterThanOrEqual(99);
    expect(accepted.length).toBeLessThanOrEqual(101);
  });

  it('averages the target rate when the camera rate is not a multiple of it', () => {
    const accepted = pace(10, range(150, (i) => (i * 1000) / 15)); // 10 s at 15 fps
    expect(accepted.length).toBeGreaterThanOrEqual(99);
    expect(accepted.length).toBeLessThanOrEqual(101);
  });

  it('does not burst after a stall', () => {
    const times = [0, 100, 200, 1500, ...range(30, (i) => 1500 + ((i + 1) * 1000) / 60)];
    const accepted = pace(10, times);
    for (let i = 1; i < accepted.length; i++) expect(accepted[i] - accepted[i - 1]).toBeGreaterThanOrEqual(50);
  });

  it('applies a new frame rate from the next frame', () => {
    const pacer = new FramePacer(30);
    const times = range(60, (i) => (i * 1000) / 30); // 2 s at 30 fps
    const first = times.slice(0, 30).filter((t) => pacer.accept(t * 1000)).length;
    pacer.fps = 10;
    const second = times.slice(30).filter((t) => pacer.accept(t * 1000)).length;
    expect(first).toBe(30);
    expect(second).toBeGreaterThanOrEqual(10);
    expect(second).toBeLessThanOrEqual(11);
  });
});
