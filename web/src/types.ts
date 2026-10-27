// Shapes of the API responses the staff and landowner pages read. They mirror the SQL in
// server/src/routes; numeric columns that PostgreSQL returns as numeric/bigint arrive as strings.
import type { Geometry } from 'geojson';

export type CaseType = 'first_registration' | 'transfer' | 'subdivision' | 'consolidation' | 'correction' | 'migration' | 'confirmation';
export type Classification = 'public' | 'restricted' | 'highly_sensitive';
export type Severity = 'error' | 'warning';

export interface CountyRef { id: number; code: string; name: string }

export interface LandCase {
  id: string;
  case_no: string;
  case_type: CaseType;
  county_id: number;
  county: CountyRef;
  parcel_id: string | null;
  status: string;
  proposed_upi: string | null;
  land_category: string | null;
  land_use: string | null;
  source_reference: string | null;
  correction_reason: string | null;
  area_m2_surveyed: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface CaseEvent { id: string; action: string; from_status: string | null; to_status: string | null; note: string | null; at: string; actor: string | null }

export interface ProposedRight {
  id: string; rrr_type: string; share_num: number | null; share_den: number | null; feature_index: number | null;
  party_id: string; party_name: string; party_type: string; identity_status: string;
}

export interface CaseDocument {
  id: string; doc_type: string; reference_no: string | null; issuer: string | null; issued_on: string | null;
  classification: Classification; mime_type: string; size_bytes: number; original_name: string; sha256: string;
  verification_status: 'pending' | 'verified' | 'rejected'; verification_note: string | null;
  uploaded_at: string; verified_at: string | null; uploaded_by_username: string; verified_by_username: string | null;
  canDownload: boolean; canVerify: boolean;
}

/** Attributes of a legacy feature as read from the imported file: anything may be missing. */
export interface FeatureProperties { legacy_ref?: string; land_category?: string; land_use?: string; holder_names?: string; [key: string]: unknown }

export interface StagedFeature {
  index: number; properties: FeatureProperties; excluded: boolean; exclusion_reason: string | null; published_upi: string | null;
  structural_ok: boolean; structural_message: string | null; geometry: Geometry; area_m2: string | null;
}

export interface StagedBatch { batch_id: string; source_filename: string; declared_srid: number; created_at: string; uploaded_by: string; features: StagedFeature[] }

export interface RightSummary { rrrType: string; share: string | null; partyName: string; partyType: string; interestStatus: string | null; ended?: boolean }

/** A published parcel as shown on a case: the parcel the case changes, or one it replaces. */
export interface CaseParcel {
  id: string; upi: string; status: string; version_no?: number; land_category: string | null; land_use: string | null;
  area_m2_calculated: string | null; area_m2_surveyed?: string | null; source_reference?: string | null;
  geometry: Geometry; current_rights: RightSummary[];
}

export interface Decision {
  id: string; decision: string; reason: string; authority_basis: string | null; snapshot_hash: string;
  decided_at: string; superseded_at: string | null; decided_by: string;
}

export interface Finding {
  id: string; run_id: string; code: string; severity: Severity; message: string;
  related_parcel_id: string | null; related_case_id: string | null; detail: { upi?: string; [key: string]: unknown } | null;
  acknowledged_by: string | null; acknowledged_at: string | null; acknowledgement_note: string | null; acknowledged_by_username: string | null;
  feature_index: number | null;
}

export interface ValidationRun { id: string; run_at: string; purpose: string; error_count: number; warning_count: number }

export interface CaseDetailResponse {
  case: LandCase;
  events: CaseEvent[];
  rights: ProposedRight[];
  documents: CaseDocument[];
  staged: StagedBatch | null;
  parcel: CaseParcel | null;
  sources: CaseParcel[];
  children: { upi: string; status: string }[];
  decisions: Decision[];
  validation: { run: ValidationRun; findings: Finding[] } | null;
  allowedActions: string[];
  separationNotice: string | null;
}

export interface PartySummary {
  id: string; name: string; party_type: string; identity_status: string; has_id_reference: boolean; is_synthetic: boolean; created_at: string;
}

export interface DocumentCategory { code: string; label: string; description: string | null }

// --- Landowner portal (/me) ---

export interface MyParcel {
  upi: string; county: string; status: string; land_category: string | null; land_use: string | null; area_m2_calculated: string;
  geometry: Geometry; my_interests: { rrrType: string; share: string | null; interestStatus: string; since: string; holder: string }[];
}

export interface MyDocumentRequest {
  id: string; request_no: string; parcel_upi: string; document_types: string[]; purpose: string; status: string;
  created_at: string; decided_at: string | null; decision_reason: string | null; release_expires_at: string | null; release_active: boolean;
  released_documents: { id: string; docType: string; referenceNo: string | null; issuedOn: string | null; fileName: string }[] | null;
}

// --- Audit (GET /audit) ---

export interface AuditEventRow {
  chain_seq: string; at: string; actor_username: string | null; action: string; outcome: 'success' | 'denied' | 'failure';
  entity_type: string | null; entity_id: string | null; county_id: number | null; county_code: string | null; case_id: string | null;
  ip: string | null; hash: string; detail: Record<string, unknown>;
}

export interface AuditListResponse { scope: 'all' | 'technical'; events: AuditEventRow[]; nextBefore: string | null }
export interface ChainVerification { intact: boolean; checked: number; firstBadSeq: string | null }

/** GET /parties/:id/sensitive: shown only on request, and every read is audited. */
export interface PartySensitive { id: string; name: string; national_id_ref: string | null; contact: string | null }

// --- Document requests (staff side) ---

export type DocumentRequestStatus = 'submitted' | 'prepared' | 'approved' | 'refused' | 'withdrawn';

export interface DocumentRequestRow {
  id: string; request_no: string; status: DocumentRequestStatus; created_at: string; updated_at: string;
  parcel_upi: string; county_code: string; requested_by_name: string; type_count: number;
}

export interface ReleaseCandidate {
  id: string; doc_type: string; reference_no: string | null; issuer: string | null; issued_on: string | null;
  classification: Classification; original_name: string; size_bytes: number; case_no: string; case_type: CaseType;
  releasable: boolean; selected: boolean;
}

export interface DocumentRequestDetailResponse {
  request: {
    id: string; request_no: string; status: DocumentRequestStatus; document_types: string[]; purpose: string;
    created_at: string; prepared_at: string | null; preparation_note: string | null; decided_at: string | null;
    decision_reason: string | null; release_expires_at: string | null;
    parcel_upi: string; county_name: string; requested_by_username: string; requested_by_name: string; party_name: string;
    prepared_by_username: string | null; decided_by_username: string | null; interest_current: boolean;
  };
  candidates: ReleaseCandidate[];
  allowedActions: ('prepare' | 'decide')[];
  separationNotice: string | null;
}

// --- GET /parcels/:upi (internal registry view) ---

export interface ParcelVersion {
  id: string; version_no: number; land_category: string | null; land_use: string | null; area_m2_calculated: string;
  area_m2_surveyed: string | null; area_method: string; source_reference: string | null; valid_from: string; valid_to: string | null;
  published_by_case: string | null; geometry: Geometry;
}

export interface RegisteredRight {
  id: string; rrr_type: string; share_num: number | null; share_den: number | null; interest_status: string;
  valid_from: string; valid_to: string | null; party_id: string; party_name: string; party_type: string; identity_status: string;
  created_by_case: string | null; ended_by_case: string | null;
}

export interface LineageLink { relation: 'parent' | 'child'; upi: string; status: string; case_no: string }

export interface ParcelDispute {
  id: string; reason: string; referral: string | null; opened_at: string; closed_at: string | null; resolution: string | null;
  opened_by: string; closed_by: string | null;
}

export interface ParcelRecordResponse {
  parcel: { id: string; upi: string; county_id: number; status: string; legacy_ref: string | null; is_synthetic: boolean; county: CountyRef };
  parents: LineageLink[];
  children: LineageLink[];
  versions: ParcelVersion[];
  currentRights: RegisteredRight[];
  historicalRights: RegisteredRight[];
  cases: { id: string; case_no: string; case_type: CaseType; status: string; created_at: string; updated_at: string }[];
  disputes: ParcelDispute[];
  canManageDisputes: boolean;
}
