/**
 * Decides which incoming frames to encode so the output stays at or below a
 * target frame rate.
 *
 * Frames are paced against a schedule of evenly spaced slots, not against the
 * gap since the last accepted frame. A gap check skips every frame that is a
 * little early. That happens all the time when the camera already runs at
 * the target rate, especially on the <video> path, where
 * requestVideoFrameCallback snaps frames to vsync: frames 100 ms apart arrive
 * as 83/100/117 ms gaps at 60 Hz. Each skip then costs a whole interval, and
 * 10 fps came out as 6.
 *
 * Here, a frame is taken if it is no more than half an interval early for
 * its slot. Each accepted frame moves the schedule forward by at least one
 * interval, so the average rate never exceeds the target. Accepted frames are
 * always at least half an interval apart, so a stall is not followed by a
 * burst.
 */
export class FramePacer {
  private nextSlotUs = -Infinity;

  constructor(public fps: number) {}

  /** True if the frame with this timestamp (µs) should be encoded. */
  accept(timestampUs: number): boolean {
    const interval = 1_000_000 / this.fps;
    if (timestampUs < this.nextSlotUs - interval / 2) return false;
    this.nextSlotUs = Math.max(this.nextSlotUs, timestampUs) + interval;
    return true;
  }
}
