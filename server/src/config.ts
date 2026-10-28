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
  /** pg_dump used for administrator-initiated backups; empty means look it up on PATH. */
  pgDumpPath: process.env.PG_DUMP_PATH || 'pg_dump',
  backupDir: path.resolve(process.env.BACKUP_DIR || 'storage/backups'),
  /** Uploaded GIS files awaiting import. Kept for GIS_UPLOAD_RETENTION_HOURS, then deleted. Not web-served. */
  gisUploadDir: path.resolve(process.env.GIS_UPLOAD_DIR || 'storage/gis-uploads'),
  gisUploadRetentionHours: number('GIS_UPLOAD_RETENTION_HOURS', 24),
  /** A parcel larger than this (m²) is flagged for review; 500 ha by default. */
  maxParcelAreaM2: number('MAX_PARCEL_AREA_M2', 5_000_000),
  /** Number of reverse proxies in front of the API, so client addresses are taken from X-Forwarded-For. 0 = none. */
  trustProxyHops: number('TRUST_PROXY', 0),
  /** How long a landowner can download documents released to them. */
  documentReleaseDays: number('DOCUMENT_RELEASE_DAYS', 30),
  /** A corrected boundary moving further than this from the published one is flagged for review. */
  significantBoundaryChangeM: number('SIGNIFICANT_BOUNDARY_CHANGE_M', 5),
  /** A corrected boundary changing the calculated area by more than this percentage is flagged. */
  significantAreaChangePct: number('SIGNIFICANT_AREA_CHANGE_PCT', 10),
  /** Largest gap or excess allowed between the new parcels and the parcels they replace. */
  coverageToleranceM2: number('COVERAGE_TOLERANCE_M2', 1),
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
