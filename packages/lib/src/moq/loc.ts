/**
 * Media objects on MOQT data streams, packaged as LOC (Low Overhead Media
 * Container) the way MediaMTX reads them: each frame is a group of its own on
 * its own unidirectional stream, holding one object followed by an
 * END_OF_GROUP status object.
 */
import { splitNalUnits } from '../ts/muxer';
import { concat, encodeVarint } from './varint';

/** Subgroup header types (draft 22): plain, and with per-object properties. */
const SUBGROUP = 0x30;
const SUBGROUP_WITH_PROPERTIES = 0x31;
/** LOC timestamp property, in the track's clock rate. */
const PROPERTY_TIMESTAMP = 0x06;
const STATUS_END_OF_GROUP = 3;

/**
 * One group: subgroup header, the object, and END_OF_GROUP. With a timestamp
 * (in clock-rate units) the object carries it as a property; without one (the
 * catalog) no properties are sent.
 */
export function encodeGroup(trackAlias: number, groupId: number, payload: Uint8Array, timestamp?: number): Uint8Array {
  const withProperties = timestamp !== undefined;
  const header = concat(encodeVarint(withProperties ? SUBGROUP_WITH_PROPERTIES : SUBGROUP), encodeVarint(trackAlias), encodeVarint(groupId));
  // Each object: ID delta, [property block], payload length, payload (or a status when the length is 0).
  const noProperties = withProperties ? encodeVarint(0) : new Uint8Array(0);
  let properties = noProperties;
  if (withProperties) {
    const timestampProperty = concat(encodeVarint(PROPERTY_TIMESTAMP), encodeVarint(Math.max(0, Math.round(timestamp))));
    properties = concat(encodeVarint(timestampProperty.length), timestampProperty);
  }
  const object = concat(encodeVarint(0), properties, encodeVarint(payload.length), payload);
  const endOfGroup = concat(encodeVarint(0), noProperties, encodeVarint(0), encodeVarint(STATUS_END_OF_GROUP));
  return concat(header, object, endOfGroup);
}

const NAL_AUD = 9;
const NAL_SPS = 7;
const NAL_PPS = 8;

/**
 * H.264 Annex-B access units -> 4-byte length-prefixed NAL units ("avc3":
 * parameter sets in band). Drops access unit delimiters and makes sure every
 * keyframe carries SPS and PPS, so a reader can start at any group.
 */
export class AvcPackager {
  private sps?: Uint8Array;
  private pps?: Uint8Array;

  pack(annexB: Uint8Array, keyframe: boolean): Uint8Array {
    const nals = splitNalUnits(annexB).filter((n) => n.length && (n[0] & 0x1f) !== NAL_AUD);
    const types = nals.map((n) => n[0] & 0x1f);
    nals.forEach((n, i) => {
      if (types[i] === NAL_SPS) this.sps = n;
      if (types[i] === NAL_PPS) this.pps = n;
    });
    if (keyframe && !types.includes(NAL_SPS) && this.sps && this.pps) nals.unshift(this.sps, this.pps);
    const out = new Uint8Array(nals.reduce((n, nal) => n + 4 + nal.length, 0));
    const view = new DataView(out.buffer);
    let pos = 0;
    for (const nal of nals) {
      view.setUint32(pos, nal.length);
      out.set(nal, pos + 4);
      pos += 4 + nal.length;
    }
    return out;
  }
}
