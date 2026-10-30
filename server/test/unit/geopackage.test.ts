import { describe, expect, it } from 'vitest';
import { gpkgBlobToWkb } from '../../src/services/geopackage.js';

/** A GeoPackage geometry blob: "GP", version 0, flags, srs_id (little-endian), envelope, then WKB. */
function blob(flags: number, envelopeBytes: number, wkb: number[]) {
  const header = [0x47, 0x50, 0x00, flags, 0xe6, 0x10, 0x00, 0x00];
  return Uint8Array.from([...header, ...new Array(envelopeBytes).fill(0), ...wkb]);
}
const POINT_WKB = [0x01, 0x01, 0x00, 0x00, 0x00, ...new Array(16).fill(0)];

describe('GeoPackage geometry blobs', () => {
  it.each([[0, 0], [1, 32], [2, 48], [3, 48], [4, 64]])('skips an envelope of type %i (%i bytes)', (type, bytes) => {
    const wkb = gpkgBlobToWkb(blob(0x01 | (type << 1), bytes, POINT_WKB));
    expect(Array.from(wkb!)).toEqual(POINT_WKB);
  });

  it('returns nothing for empty, extended, malformed or truncated blobs', () => {
    expect(gpkgBlobToWkb(blob(0x01 | 0x10, 0, POINT_WKB))).toBeNull(); // empty flag
    expect(gpkgBlobToWkb(blob(0x01 | 0x20, 0, POINT_WKB))).toBeNull(); // extended type
    expect(gpkgBlobToWkb(blob(0x01 | (5 << 1), 0, POINT_WKB))).toBeNull(); // invalid envelope code
    expect(gpkgBlobToWkb(Uint8Array.from([0x58, 0x58, 0, 1, 0, 0, 0, 0, ...POINT_WKB]))).toBeNull(); // not "GP"
    expect(gpkgBlobToWkb(blob(0x01 | (1 << 1), 10, []))).toBeNull(); // envelope longer than the blob
  });
});
