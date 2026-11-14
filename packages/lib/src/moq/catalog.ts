/**
 * MOQT Streaming Format (MSF) catalog, as MediaMTX reads it. Track names are
 * their index, and MediaMTX maps catalog track i to track alias i + 1.
 */

export interface MoqVideoTrack {
  /** WebCodecs codec string; H.264 is sent as "avc3.*" (parameter sets in band). */
  codec: string;
}

export interface MoqAudioTrack {
  codec: 'mp4a.40.2' | 'opus';
  sampleRate: number;
  channels: number;
}

export interface MoqTracks {
  video: MoqVideoTrack;
  audio?: MoqAudioTrack;
}

export const VIDEO_CLOCK_RATE = 90_000;

export function buildCatalog(tracks: MoqTracks): string {
  const list: Record<string, unknown>[] = [
    { name: '0', packaging: 'loc', isLive: true, codec: tracks.video.codec, clockrate: VIDEO_CLOCK_RATE },
  ];
  if (tracks.audio) {
    const { codec, sampleRate, channels } = tracks.audio;
    list.push({ name: '1', packaging: 'loc', isLive: true, codec, clockrate: sampleRate, samplerate: sampleRate, channels });
  }
  return JSON.stringify({ version: 1, tracks: list });
}

/** "avc1.64001F" -> "avc3.64001F": the frames carry SPS/PPS in band. */
export function avc3Codec(codec: string): string {
  return codec.replace(/^avc1\./, 'avc3.');
}
