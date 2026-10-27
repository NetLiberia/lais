import { describe, expect, it } from 'vitest';
import { base32Decode, base32Encode, hotp, totp, verifyTotp } from '../../src/auth/totp.js';
import { hashPassword, verifyPassword } from '../../src/auth/password.js';
import { open, seal } from '../../src/auth/secretBox.js';
import { extractFeatures, extractSingleFeature, FEATURE_LIMITS, parseCrsMember } from '../../src/services/geojson.js';
import { sharesSumToWhole } from '../../src/services/shares.js';
import { parseLegacyProperties } from '../../src/services/legacy.js';
import { detectDocumentType } from '../../src/services/files.js';

describe('TOTP (RFC 6238 / RFC 4226 test vectors)', () => {
  const secret = Buffer.from('12345678901234567890');

  it('matches the RFC 4226 HOTP values', () => {
    expect(hotp(secret, 0)).toBe('755224');
    expect(hotp(secret, 9)).toBe('520489');
  });

  it('matches the RFC 6238 SHA-1 value at T=59s', () => {
    expect(totp(base32Encode(secret), 59_000, 8)).toBe('94287082');
  });

  it('round-trips base32 and accepts one step of drift', () => {
    const b32 = base32Encode(secret);
    expect(base32Decode(b32).equals(secret)).toBe(true);
    const now = 1_700_000_000_000;
    expect(verifyTotp(b32, totp(b32, now - 30_000), now)).toBe(true);
    expect(verifyTotp(b32, totp(b32, now - 90_000), now)).toBe(false);
    expect(verifyTotp(b32, 'abcdef', now)).toBe(false);
  });
});

describe('passwords and secrets', () => {
  it('verifies the right password only', async () => {
    const h = await hashPassword('correct horse battery');
    expect(h.startsWith('scrypt$')).toBe(true);
    expect(await verifyPassword(h, 'correct horse battery')).toBe(true);
    expect(await verifyPassword(h, 'wrong horse battery')).toBe(false);
  });

  it('seals and opens with the key, and detects tampering', () => {
    const key = Buffer.alloc(32, 7);
    const sealed = seal('JBSWY3DPEHPK3PXP', key);
    expect(open(sealed, key)).toBe('JBSWY3DPEHPK3PXP');
    const [iv, tag, ct] = sealed.split('.');
    const flipped = Buffer.from(ct, 'base64');
    flipped[0] ^= 1;
    expect(() => open([iv, tag, flipped.toString('base64')].join('.'), key)).toThrow();
  });
});

describe('GeoJSON intake', () => {
  const polygon = { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] };

  it('recognises CRS declarations', () => {
    expect(parseCrsMember(undefined)).toBeNull();
    expect(parseCrsMember({ type: 'name', properties: { name: 'urn:ogc:def:crs:OGC:1.3:CRS84' } })).toBe(4326);
    expect(parseCrsMember({ type: 'name', properties: { name: 'urn:ogc:def:crs:EPSG::32629' } })).toBe(32629);
    expect(() => parseCrsMember({ type: 'name', properties: { name: 'local' } })).toThrow();
  });

  it('rejects a file whose CRS conflicts with the declared CRS', () => {
    const doc = { type: 'FeatureCollection', crs: { type: 'name', properties: { name: 'EPSG:32629' } }, features: [{ type: 'Feature', geometry: polygon, properties: {} }] };
    expect(() => extractSingleFeature(JSON.stringify(doc), 4326)).toThrow(/conflicts/);
  });

  it('takes exactly one feature', () => {
    const two = { type: 'FeatureCollection', features: [{ type: 'Feature', geometry: polygon }, { type: 'Feature', geometry: polygon }] };
    expect(() => extractSingleFeature(JSON.stringify(two), 4326)).toThrow(/exactly one/);
    expect(extractSingleFeature(JSON.stringify(polygon), 4326).geometry).toEqual(polygon);
  });

  it('enforces per-case feature counts', () => {
    const fc = (n: number) => JSON.stringify({ type: 'FeatureCollection', features: Array.from({ length: n }, () => ({ type: 'Feature', geometry: polygon })) });
    expect(() => extractFeatures(fc(1), 4326, FEATURE_LIMITS.subdivision)).toThrow(/between 2 and 50/);
    expect(extractFeatures(fc(3), 4326, FEATURE_LIMITS.subdivision)).toHaveLength(3);
    expect(() => extractFeatures(fc(2), 4326, FEATURE_LIMITS.consolidation)).toThrow(/exactly one merged/);
  });

  it('rejects non-JSON', () => {
    expect(() => extractSingleFeature('not json', 4326)).toThrow(/valid JSON/);
  });
});

describe('legacy record attributes', () => {
  it('accepts a complete record and normalises it', () => {
    const r = parseLegacyProperties({ legacy_ref: ' LR-1 ', land_category: 'Private', surveyed_area_m2: '7800.456', holder_names: 'A Name; B Name ;', holder_type: 'Person' });
    expect(r).toMatchObject({ legacyRef: 'LR-1', landCategory: 'private', surveyedAreaM2: 7800.46, holders: ['A Name', 'B Name'], holderType: 'person', problems: [] });
  });

  it('reports every problem instead of guessing', () => {
    const r = parseLegacyProperties({ land_category: 'freehold', surveyed_area_m2: '-5', holder_type: 'company' });
    expect(r.problems).toHaveLength(4);
    expect(r.landCategory).toBeNull();
  });
});

describe('ownership shares', () => {
  it('uses exact fractions', () => {
    expect(sharesSumToWhole([{ num: 1, den: 3 }, { num: 1, den: 3 }, { num: 1, den: 3 }])).toBe(true);
    expect(sharesSumToWhole([{ num: 1, den: 2 }, { num: 1, den: 3 }])).toBe(false);
    expect(sharesSumToWhole([{ num: 1, den: 1 }])).toBe(true);
    expect(sharesSumToWhole([])).toBe(false);
  });
});

describe('document type detection', () => {
  it('trusts content, not names', () => {
    expect(detectDocumentType(Buffer.from('%PDF-1.4\n...'))).toBe('application/pdf');
    expect(detectDocumentType(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    expect(detectDocumentType(Buffer.from('<html><script>'))).toBeNull();
  });
});
