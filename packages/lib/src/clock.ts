/**
 * The shared stream clock: microseconds since streaming started. Video, audio
 * and KLV are all stamped on it so the muxer can align them.
 */
export class StreamClock {
  private readonly startMs: number;

  constructor(private readonly now: () => number = () => performance.now()) {
    this.startMs = now();
  }

  nowUs(): number {
    return Math.round((this.now() - this.startMs) * 1000);
  }
}
