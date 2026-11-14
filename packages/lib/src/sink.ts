/**
 * Where encoded media goes: MPEG-TS (with KLV) to the relay, or MoQ to a
 * Media over QUIC server. The Streamer encodes once and writes to one sink.
 */
import { AudioPesBuffer, type EncodedAudio } from './audio';
import type { EncodedFrame } from './encoder';
import type { MoqPublisher } from './moq/publisher';
import type { Transport } from './transport';
import { TsMuxer, type MuxerAudioConfig } from './ts/muxer';

export interface MediaSink {
  /** e.g. "webtransport/datagram", "websocket" or "moq". */
  readonly kind: string;
  readonly bytesSent: number;
  /** Bytes waiting to be sent; the encoder skips frames when this grows. */
  readonly bufferedAmount: number;
  writeVideo(frame: EncodedFrame): void;
  writeAudio(frame: EncodedAudio): void;
  /** Absent when the output cannot carry KLV metadata. */
  writeKlv?(klv: Uint8Array, timestampUs: number): void;
  close(): void;
}

/** MPEG-TS over a relay transport. */
export class TsSink implements MediaSink {
  private readonly muxer: TsMuxer;
  private readonly pes: AudioPesBuffer;

  constructor(
    private readonly transport: Transport,
    audio?: MuxerAudioConfig,
  ) {
    this.muxer = new TsMuxer({ onData: (d) => transport.send(d), audio });
    this.pes = new AudioPesBuffer((frames, timestampUs) => this.muxer.writeAudio(frames, timestampUs));
  }

  get kind() {
    return this.transport.kind;
  }

  get bytesSent() {
    return this.transport.bytesSent;
  }

  get bufferedAmount() {
    return this.transport.bufferedAmount;
  }

  writeVideo(frame: EncodedFrame): void {
    this.muxer.writeVideo(frame.data, frame.timestampUs, frame.keyframe);
  }

  writeAudio(frame: EncodedAudio): void {
    this.pes.push(frame);
  }

  writeKlv(klv: Uint8Array, timestampUs: number): void {
    this.muxer.writeKlv(klv, timestampUs);
  }

  close(): void {
    this.transport.close();
  }
}

/** MoQ: video and audio only; KLV is not carried. */
export class MoqSink implements MediaSink {
  constructor(private readonly publisher: MoqPublisher) {}

  get kind() {
    return this.publisher.kind;
  }

  get bytesSent() {
    return this.publisher.bytesSent;
  }

  get bufferedAmount() {
    return this.publisher.bufferedAmount;
  }

  writeVideo(frame: EncodedFrame): void {
    this.publisher.writeVideo(frame.data, frame.timestampUs, frame.keyframe);
  }

  writeAudio(frame: EncodedAudio): void {
    this.publisher.writeAudio(frame.raw, frame.timestampUs);
  }

  close(): void {
    this.publisher.close();
  }
}
