# web-video-streamer

Stream a phone (or any browser) camera as **MPEG-TS** with **MISB ST 0601 KLV** metadata: location, camera pointing direction, field of view and ground footprint, sent once per second. Video is encoded in the browser with WebCodecs and sent over WebTransport (or a WebSocket fallback) to [`web-video-streamer-relay`](https://www.npmjs.com/package/web-video-streamer-relay), which forwards it as UDP.

```sh
npm install web-video-streamer
```

```ts
import { createStreamer } from 'web-video-streamer';

const streamer = createStreamer({
  webTransportUrl: 'https://relay.example.com:4433/stream',
  relayUrl: 'wss://relay.example.com:8090', // fallback
  target: 'udp://10.0.0.5:5000',
  videoElement: document.querySelector('video')!,
});
streamer.on('stats', console.log);
button.onclick = () => streamer.start(); // from a user gesture
```

Requires a secure (HTTPS) page. Full documentation (options, KLV tags, how FOV and footprint are derived, browser support): https://github.com/clockard/web-video-streamer#readme

MIT License
