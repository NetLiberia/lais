import 'dotenv/config';
import path from 'node:path';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable ${name} (see server/.env.example)`);
  return value;
}

function number(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`Environment variable ${name} must be a number`);
  return value;
}

const mfaKey = required('MFA_ENCRYPTION_KEY');
if (!/^[0-9a-fA-F]{64}$/.test(mfaKey)) {
  throw new Error('MFA_ENCRYPTION_KEY must be 64 hex characters (32 bytes)');
}

export const config = {
  env: process.env.NODE_ENV ?? 'development',
  port: number('PORT', 4000),
  databaseUrl: required('DATABASE_URL'),
  databasePoolMax: number('DATABASE_POOL_MAX', 10),
  mfaEncryptionKey: Buffer.from(mfaKey, 'hex'),
  mfaEnforced: process.env.MFA_ENFORCED === 'true',
  sessionIdleMinutes: number('SESSION_IDLE_MINUTES', 30),
  sessionAbsoluteHours: number('SESSION_ABSOLUTE_HOURS', 8),
  documentStorageDir: path.resolve(process.env.DOCUMENT_STORAGE_DIR || 'storage/documents'),
  maxUploadBytes: number('MAX_UPLOAD_BYTES', 10 * 1024 * 1024),
  overlapToleranceM2: number('OVERLAP_TOLERANCE_M2', 1),
  duplicateHausdorffM: number('DUPLICATE_HAUSDORFF_M', 2),
  minParcelAreaM2: number('MIN_PARCEL_AREA_M2', 10),
};

export const isProduction = config.env === 'production';
export const isTest = config.env === 'test';

/**
 * Approximate bounding box of Liberia (lon/lat). Used only as a sanity check that
 * catches wrong CRS declarations and swapped axes. It is not an official boundary.
 */
export const NATIONAL_EXTENT = { minLon: -11.7, minLat: 4.2, maxLon: -7.2, maxLat: 8.7 };

/** Metric CRS used for distance comparisons. WGS 84 / UTM zone 29N covers Liberia. */
export const METRIC_SRID = 32629;
