/** A connection to the relay that carries whole MPEG-TS packets. */
export interface Transport {
  /** e.g. "websocket" or "webtransport/datagram". */
  readonly kind: string;
  readonly connected: boolean;
  /** Bytes accepted by send() but not yet handed to the network; drives backpressure. */
  readonly bufferedAmount: number;
  readonly bytesSent: number;
  /** Resolves on the first successful connection; rejects if it cannot connect. */
  connect(): Promise<void>;
  /** Send one or more whole 188-byte TS packets. Dropped while disconnected. */
  send(data: Uint8Array): void;
  close(): void;
}

export interface TransportEvents {
  onOpen: () => void;
  /** reason ends with "reconnecting" when the transport will retry by itself. */
  onClose: (reason: string) => void;
}

/** WebSocket connection to the relay, reconnecting while the stream is running. */
export class WebSocketTransport implements Transport {
  readonly kind = 'websocket';
  bytesSent = 0;
  private ws?: WebSocket;
  private closed = false;
  private retryTimer?: ReturnType<typeof setTimeout>;
  private retryDelay = 1000;

  constructor(
    private readonly url: string,
    private readonly events: TransportEvents,
  ) {}

  /** Resolves on the first successful connection. */
  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      let first = true;
      const open = () => {
        const ws = new WebSocket(this.url);
        ws.binaryType = 'arraybuffer';
        this.ws = ws;
        ws.onopen = () => {
          this.retryDelay = 1000;
          this.events.onOpen();
          if (first) resolve();
          first = false;
        };
        ws.onclose = (e) => {
          const reason = e.reason || `code ${e.code}`;
          if (first) {
            first = false;
            reject(new Error(`Could not connect to relay ${this.url}: ${reason}`));
            return;
          }
          if (this.closed) return;
          // 1008 = the relay rejected this device; 4001 = a newer connection from this
          // device replaced us. Retrying will not help in either case.
          if (e.code === 1008 || e.code === REPLACED_CLOSE_CODE) {
            this.events.onClose(reason);
            return;
          }
          this.events.onClose(`${reason}, reconnecting`);
          this.retryTimer = setTimeout(open, this.retryDelay);
          this.retryDelay = Math.min(this.retryDelay * 2, 10_000);
        };
      };
      open();
    });
  }

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  get bufferedAmount(): number {
    return this.ws?.bufferedAmount ?? 0;
  }

  send(data: Uint8Array): void {
    if (!this.connected) return;
    this.ws!.send(data);
    this.bytesSent += data.byteLength;
  }

  close(): void {
    this.closed = true;
    clearTimeout(this.retryTimer);
    this.ws?.close(1000, 'stopped');
  }
}

/** Close code the relay uses when a newer connection from the same device takes over. */
export const REPLACED_CLOSE_CODE = 4001;

/** Build the relay WebSocket URL carrying the device ID (and optional name). */
export function relayUrl(relay: string, deviceId: string, deviceName?: string): string {
  const url = new URL(relay, typeof location !== 'undefined' ? location.href : undefined);
  if (url.protocol === 'http:') url.protocol = 'ws:';
  if (url.protocol === 'https:') url.protocol = 'wss:';
  url.searchParams.set('device', deviceId);
  if (deviceName) url.searchParams.set('name', deviceName);
  return url.toString();
}
