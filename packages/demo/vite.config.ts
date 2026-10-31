import { defineConfig } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';
import { resolve } from 'node:path';

// HTTPS is required for camera, geolocation and orientation access on phones.
// The relay runs separately (npm run relay); /relay is proxied to it so the
// page can use a same-origin wss:// URL without a second certificate.
const relayPort = process.env.RELAY_PORT ?? '8090';

export default defineConfig({
  plugins: [basicSsl()],
  resolve: {
    alias: { 'web-video-streamer': resolve(import.meta.dirname, '../lib/src/index.ts') },
  },
  server: {
    proxy: {
      '/relay': {
        // http target with ws:true carries the WebSocket, GET /relay/cert-hash and the /relay/streams API.
        target: `http://127.0.0.1:${relayPort}`,
        ws: true,
        // Lets the relay show the phone's IP rather than 127.0.0.1 (trusted only from loopback).
        xfwd: true,
        rewrite: (path) => path.replace(/^\/relay/, ''),
      },
    },
  },
});
