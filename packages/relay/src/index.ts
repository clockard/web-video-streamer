/** Programmatic API; the `web-video-streamer-relay` command (cli.ts) wraps startRelay(). */
export { startRelay, type RelayServerOptions } from './server.js';
export { createRelay, isAllowed, parseTarget, DATAGRAM_SIZE, type RelayOptions, type RelayTarget } from './relay.js';
export {
  StreamRegistry,
  StreamError,
  REPLACED_CLOSE_CODE,
  clientAddress,
  parsePortRange,
  type StreamInfo,
  type StreamMapping,
  type StreamRegistryOptions,
  type StreamSession,
} from './streams.js';
export { createWebTransportRelay, WEBTRANSPORT_PATH, type WebTransportRelayOptions } from './webtransport.js';
export { certificateHash, generateSelfSignedCertificate, SELF_SIGNED_VALIDITY_DAYS, type ServerCertificate } from './cert.js';
