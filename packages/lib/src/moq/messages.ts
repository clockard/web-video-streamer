/**
 * The MOQT draft 22 control messages a publisher needs, laid out as
 * MediaMTX's own browser publisher sends them (internal/servers/moq/publisher.js,
 * MediaMTX v1.21): type varint, 16-bit big-endian length, payload.
 */
import { concat, decodeVarint, encodeString, encodeTuple, encodeVarint } from './varint';

export const MOQT_PROTOCOL = 'moqt-22';

export const MSG_SETUP = 0x2f00;
export const MSG_PUBLISH = 0x1d;
export const MSG_REQUEST_OK = 0x07;
export const MSG_REQUEST_ERROR = 0x05;

const PARAM_AUTH_TOKEN = 0x03;
/** Auth token alias type: the value is carried in full. */
const AUTH_USE_VALUE = 3;
/** Token type 0: negotiated out of band (here: an HTTP Authorization header value). */
const TOKEN_TYPE_OUT_OF_BAND = 0;

export function encodeMessage(type: number, payload: Uint8Array): Uint8Array {
  if (payload.length > 0xffff) throw new RangeError(`control message too long: ${payload.length} bytes`);
  return concat(encodeVarint(type), new Uint8Array([payload.length >> 8, payload.length & 0xff]), payload);
}

/** CLIENT_SETUP with no parameters; the version is chosen by the WebTransport protocol (moqt-22). */
export function encodeClientSetup(): Uint8Array {
  return encodeMessage(MSG_SETUP, new Uint8Array(0));
}

export type MoqCredentials = { user: string; pass: string } | { token: string };

/** The Authorization header value for these credentials, as MediaMTX expects it. */
export function authorizationValue(credentials?: MoqCredentials): string | undefined {
  if (!credentials) return undefined;
  if ('token' in credentials) return credentials.token ? `Bearer ${credentials.token}` : undefined;
  if (!credentials.user) return undefined;
  const bytes = new TextEncoder().encode(`${credentials.user}:${credentials.pass}`);
  return `Basic ${btoa(String.fromCharCode(...bytes))}`;
}

/** Parameter list: none, or one AUTHORIZATION TOKEN carrying the Authorization header value. */
export function encodeAuthParams(authorization?: string): Uint8Array {
  if (!authorization) return encodeVarint(0);
  const token = concat(encodeVarint(AUTH_USE_VALUE), encodeVarint(TOKEN_TYPE_OUT_OF_BAND), new TextEncoder().encode(authorization));
  return concat(encodeVarint(1), encodeVarint(PARAM_AUTH_TOKEN), encodeVarint(token.length), token);
}

export interface PublishMessage {
  requestId: number;
  namespace: readonly string[];
  trackName: string;
  trackAlias: number;
  authorization?: string;
}

export function encodePublish(m: PublishMessage): Uint8Array {
  return encodeMessage(
    MSG_PUBLISH,
    concat(encodeVarint(m.requestId), encodeTuple(m.namespace), encodeString(m.trackName), encodeVarint(m.trackAlias), encodeAuthParams(m.authorization)),
  );
}

export interface RequestError {
  code: number;
  retryIntervalMs: number;
  reason: string;
}

/** REQUEST_ERROR payload: error code, retry interval, reason phrase. */
export function decodeRequestError(payload: Uint8Array): RequestError {
  let off = 0;
  const next = () => {
    const v = decodeVarint(payload, off);
    off += v.size;
    return Number(v.value);
  };
  const code = next();
  const retryIntervalMs = next();
  const length = next();
  const reason = new TextDecoder().decode(payload.subarray(off, off + length));
  return { code, retryIntervalMs, reason };
}
