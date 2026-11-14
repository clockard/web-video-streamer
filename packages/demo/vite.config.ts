import { defineConfig, type Plugin } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';
import { get } from 'node:https';
import { resolve } from 'node:path';

// HTTPS is required for camera, geolocation and orientation access on phones.
// The relay runs separately (npm run relay); /relay is proxied to it so the
// page can use a same-origin wss:// URL without a second certificate.
const relayPort = process.env.RELAY_PORT ?? '8090';

/**
 * GET /mediamtx-fingerprint?url=https://host:8892/<path>/fingerprint
 *
 * MediaMTX's MoQ certificate is self-signed, so a browser won't fetch its
 * fingerprint until someone opens that origin and accepts the warning (and
 * phones make that awkward). The dev server fetches it instead and returns it
 * from the page's own origin. The page then pins the hash for WebTransport,
 * which is the same trust MediaMTX's own publish page relies on. Only HTTPS URLs
 * ending in /fingerprint are fetched, and only a SHA-256 hex string is passed back.
 */
function mediamtxFingerprint(): Plugin {
  return {
    name: 'mediamtx-fingerprint',
    configureServer(server) {
      server.middlewares.use('/mediamtx-fingerprint', (req, res) => {
        const fail = (status: number, message: string) => {
          res.statusCode = status;
          res.setHeader('content-type', 'text/plain');
          res.end(message);
        };
        let target: URL;
        try {
          target = new URL(new URL(req.url ?? '', 'http://x').searchParams.get('url') ?? '');
        } catch {
          return fail(400, 'url must be an absolute https URL');
        }
        if (target.protocol !== 'https:' || !target.pathname.endsWith('/fingerprint')) return fail(400, 'url must be https://.../fingerprint');
        const upstream = get(target, { rejectUnauthorized: false, timeout: 5000 }, (up) => {
          let body = '';
          up.setEncoding('utf8');
          up.on('data', (chunk: string) => {
            body += chunk;
            if (body.length > 256) {
              fail(502, `unexpected answer from ${target.origin}`);
              up.destroy();
            }
          });
          up.on('end', () => {
            if (res.writableEnded) return;
            const hash = body.trim();
            if (up.statusCode !== 200 || !/^[0-9a-f]{64}$/i.test(hash)) return fail(502, `unexpected answer from ${target.origin} (HTTP ${up.statusCode})`);
            res.setHeader('content-type', 'text/plain');
            res.setHeader('cache-control', 'no-store');
            res.end(hash);
          });
        });
        upstream.on('timeout', () => upstream.destroy(new Error('timed out')));
        upstream.on('error', (err) => !res.headersSent && fail(502, `could not reach ${target.origin}: ${err.message}`));
      });
    },
  };
}

export default defineConfig({
  plugins: [basicSsl(), mediamtxFingerprint()],
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
