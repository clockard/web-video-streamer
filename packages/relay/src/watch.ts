/**
 * Viewer side of the relay: browsers watch a device's stream over WebSocket.
 *
 * Protocol: connect to /watch?device=<id>[&token=<admin token>]. The relay
 * sends text frames {"type":"status","connected":boolean} (first on connect,
 * then whenever the device starts or stops streaming) and binary frames with
 * the device's MPEG-TS, one datagram of whole TS packets per frame, exactly
 * as forwarded to its UDP output.
 */
import type { IncomingMessage } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { clientAddress, StreamError, type StreamRegistry } from './streams.js';

export const WATCH_PATH = '/watch';

/** Close code when the requested device is unknown to the relay. */
export const UNKNOWN_DEVICE_CLOSE_CODE = 4004;

/** Datagrams are dropped for a viewer while more than this many bytes wait to be sent to it. */
export const VIEWER_MAX_BUFFERED = 1024 * 1024;

export interface WatchServerOptions {
  registry: StreamRegistry;
  /** When set, viewers must pass it as ?token= (browsers cannot set headers) or "Authorization: Bearer". */
  adminToken?: string;
  log?: (msg: string) => void;
}

/** A WebSocketServer in noServer mode; hand it upgrade requests for WATCH_PATH. */
export function createWatchServer(options: WatchServerOptions): WebSocketServer {
  const log = options.log ?? (() => {});
  const wss = new WebSocketServer({ noServer: true });

  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    const peer = clientAddress(req.socket.remoteAddress, req.headers['x-forwarded-for']);
    const params = new URL(req.url ?? '/', 'http://relay').searchParams;
    const deviceId = params.get('device') ?? '';

    if (options.adminToken) {
      const token = params.get('token') ?? req.headers.authorization?.replace(/^Bearer /, '');
      if (token !== options.adminToken) {
        log(`rejecting viewer ${peer}: admin token required`);
        ws.close(1008, 'admin token required');
        return;
      }
    }

    let unsubscribe: () => void;
    let dropping = false;
    try {
      unsubscribe = options.registry.subscribe(deviceId, {
        data(datagram) {
          if (ws.readyState !== ws.OPEN) return;
          // A slow viewer loses data rather than holding up the relay; its demuxer resyncs on the next keyframe.
          if (ws.bufferedAmount > VIEWER_MAX_BUFFERED) {
            if (!dropping) log(`viewer ${peer} of ${deviceId} is falling behind; dropping data`);
            dropping = true;
            return;
          }
          dropping = false;
          ws.send(datagram);
        },
        status(connected) {
          if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'status', connected }));
        },
        end() {
          ws.close(UNKNOWN_DEVICE_CLOSE_CODE, 'device forgotten');
        },
      });
    } catch (err) {
      const message = (err as Error).message;
      log(`rejecting viewer ${peer} of ${deviceId || '(none)'}: ${message}`);
      ws.close(err instanceof StreamError && err.status === 404 ? UNKNOWN_DEVICE_CLOSE_CODE : 1008, message);
      return;
    }

    log(`viewer ${peer} watching ${deviceId}`);
    ws.on('close', () => {
      unsubscribe();
      log(`viewer ${peer} stopped watching ${deviceId}`);
    });
  });

  return wss;
}
