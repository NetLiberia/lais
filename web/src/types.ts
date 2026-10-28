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
  /** The latest supervisory quality review, and whether it covers the current validation run. */
  qualityReview: {
    mode: 'optional' | 'required';
    applies: boolean;
    latest: {
      decision: 'accepted' | 'returned' | 'info_requested'; created_at: string; validation_run_id: string | null; notes: string; reviewer: string;
      issue_categories: string[]; affected_features: number[]; instructions: string | null;
    } | null;
    acceptedForCurrentRun: boolean;
  };
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

// --- Supervision (/supervision, /tasks, /escalations) ---

export type Priority = 'low' | 'normal' | 'high' | 'urgent';
export type TaskStatus = 'unassigned' | 'assigned' | 'in_progress' | 'blocked' | 'returned' | 'completed' | 'cancelled';
export type ConflictStatus = 'new' | 'investigating' | 'awaiting_correction' | 'escalated' | 'resolved' | 'closed';

export interface SupervisionScope {
  national: boolean;
  counties: { id: number; code: string; name: string; enabled: boolean; boundary_status: string }[];
  reviewMode: 'optional' | 'required';
  stageTargets: Record<string, number> | null;
  issueCategories: { code: string; label: string; applies_to: string }[];
  taskTypes: { key: string; label: string; roles: string[] }[];
  stages: { key: string; label: string; statuses: string[] }[];
}

export interface SupervisorSummary {
  range: { from: string; to: string; countyId: number | null };
  reviewMode: 'optional' | 'required';
  applications_total: number; applications_open: number; awaiting_processing: number; awaiting_quality_review: number;
  returned_for_correction: number; awaiting_registrar: number; under_review: number; overdue_tasks: number; tasks_completed: number;
  avg_processing_days: string | null; decided_count: number; submissions_validated: number; submissions_passed: number;
  unresolved_conflicts: number; quality_pass_rate: number | null; refreshedAt: string;
}

export interface WorkloadRow {
  id: string; username: string; display_name: string; roles: string; assigned: number; active: number; blocked: number; overdue: number;
  returned: number; awaiting_response: number; completed: number; avg_completion_hours: number | null; submissions_returned: number;
  openByType: Record<string, number>;
}

export interface SupervisorCharts {
  range: { from: string; to: string; countyId: number | null };
  stages: { key: string; label: string; count: number }[];
  workCompleted: { day: string; tasks_completed: number; stage_completions: number }[];
  gisQuality: {
    valid: number; invalid: number; warnings: number; duplicate_identifiers: number; invalid_geometries: number;
    potential_overlaps: number; out_of_boundary: number; features: number; boundariesVerified: boolean;
  };
  stageDurations: { status: string; n: number; avgHours: number | null; medianHours: number | null }[];
  staffWorkload: WorkloadRow[];
  conflictStatus: { review_status: ConflictStatus; count: number }[];
}

export interface QueueItem {
  id: string; case_no: string; case_type: CaseType; status: string; priority: Priority; due_date: string | null; created_at: string;
  county_id: number; county_code: string; county_name: string; upi: string | null; stage: string; stage_since: string;
  submitted_at: string | null; last_activity: string | null; opened_by: string; assignees: string | null; proposed_holders: number;
  error_count: number | null; warning_count: number | null; quality_accepted: boolean; days_overdue: number | null;
}
export interface Paged<T> { items: T[]; total: number; page: number; pageSize: number }

export interface SupervisedCase {
  caseId: string; caseNo: string; countyId: number; status: string; stage: string; qualityAccepted: boolean; priority: Priority;
  dueDate: string | null; reviewMode: 'optional' | 'required'; responsibleOfficer: { id: string; username: string; role: string } | null;
  canReview: boolean; canSetPriority: boolean; acceptBlockedBy: string[];
  reviews: {
    id: string; decision: 'accepted' | 'returned' | 'info_requested'; issue_categories: string[]; affected_features: number[]; notes: string;
    instructions: string | null; case_status: string; created_at: string; validation_run_id: string | null; reviewer: string;
    task_no: string | null; task_status: TaskStatus | null; response: string | null;
  }[];
  tasks: { id: string; task_no: string; task_type: string; title: string; status: TaskStatus; priority: Priority; due_date: string | null; assignee: string | null }[];
  escalations: { id: string; escalation_no: string; category: string; severity: string; status: string; responsible_role: string; title: string; created_at: string }[];
  notes: { action: string; note: string; at: string; actor: string | null }[];
}

export interface GisQueueItem {
  case_id: string; case_no: string; case_type: CaseType; case_status: string; county_id: number; county_code: string; batch_id: string;
  source_filename: string; declared_srid: number; feature_count: number; imported_at: string; gis_officer: string; submitted_at: string | null;
  run_id: string | null; run_at: string | null; error_count: number | null; warning_count: number | null; last_review: string | null;
  accepted: boolean; valid_records: number; invalid_records: number; excluded_records: number; potential_conflicts: number;
  review_status: 'awaiting_review' | 'accepted' | 'returned' | 'returned_by_validation' | 'not_submitted' | 'decided';
  validation_status: 'not_validated' | 'failed' | 'passed_with_warnings' | 'passed';
}

export interface ReviewFinding extends Finding { group: string }
export interface GisReviewDetail {
  case: { id: string; caseNo: string; caseType: CaseType; status: string; countyId: number };
  submission: {
    id: string; source_filename: string; file_sha256: string; declared_srid: number; feature_count: number; status: string;
    created_at: string; uploaded_by: string; sourceCrs: string; targetCrs: string;
  } | null;
  validation: { run: ValidationRun & { batch_id: string | null }; findings: ReviewFinding[]; summary: { group: string; errors: number; warnings: number }[] } | null;
  records: {
    feature_index: number; properties: Record<string, unknown>; structural_ok: boolean; structural_message: string | null; excluded: boolean;
    exclusion_reason: string | null; geometry: Geometry; area_m2: string | null; geometry_type: string | null; errors: number; warnings: number;
  }[];
  county: { id: number; name: string; boundary_status: string; boundary_source: string | null; geometry: Geometry | null };
  references: { id: string; upi: string; status: string; geometry: Geometry }[];
  overlaps: { finding_id: string; code: string; feature_index: number; upi: string; geometry: Geometry; area_m2: string }[];
  history: {
    id: string; source_filename: string; status: string; created_at: string; feature_count: number; uploaded_by: string;
    runs: { id: string; runAt: string; purpose: string; errors: number; warnings: number }[];
  }[];
  events: { action: string; from_status: string | null; to_status: string | null; note: string | null; at: string; actor: string | null }[];
}

export interface ConflictRow {
  id: string; code: string; severity: 'error' | 'warning'; message: string; detail: Record<string, unknown> | null; feature_index: number | null;
  related_parcel_id: string | null; related_case_id: string | null; acknowledged_at: string | null; acknowledgement_note: string | null;
  acknowledged_by: string | null; run_id: string; batch_id: string | null; case_id: string; case_no: string; case_type: CaseType; case_status: string;
  county_id: number; county_code: string; related_upi: string | null; related_case_no: string | null; case_parcel_upi: string | null;
  proposed_upi: string | null; category: string; category_label: string; method: string; rule_version: string; detected_at: string;
  last_update: string; in_latest_run: boolean; last_action: string | null; last_note: string | null; task_id: string | null; task_no: string | null;
  task_status: TaskStatus | null; investigator: string | null; escalation_id: string | null; escalation_no: string | null;
  escalation_status: string | null; review_status: ConflictStatus;
}

export interface ConflictDetail {
  conflict: ConflictRow;
  occurrences: { id: string; severity: string; message: string; detail: Record<string, unknown> | null; run_at: string; purpose: string; acknowledged_at: string | null; acknowledgement_note: string | null }[];
  events: { id: string; action: string; note: string; at: string; actor: string; task_no: string | null; escalation_no: string | null }[];
  tasks: { id: string; task_no: string; task_type: string; status: TaskStatus; due_date: string | null; assignee: string | null; completion_note: string | null }[];
  escalations: { id: string; escalation_no: string; status: string; severity: string; responsible_role: string; created_at: string; closure_reason: string | null }[];
  evidence: { feature: Geometry | null; related_parcel: Geometry | null; intersection: Geometry | null; intersection_m2: string | null; feature_m2: string | null } | null;
}

export interface TaskRow {
  id: string; task_no: string; task_type: string; title: string; status: TaskStatus; priority: Priority; due_date: string | null;
  created_at: string; updated_at: string; completed_at: string | null; county_id: number; county_code: string; case_id: string | null;
  case_no: string | null; assignee_id: string | null; assignee: string | null; created_by: string; overdue: boolean; days_overdue: number | null;
}

export interface TaskDetail {
  task: TaskRow & {
    description: string | null; instructions: string | null; reference: string | null; county_name: string; created_by_username: string;
    source_filename: string | null; finding_code: string | null; finding_message: string | null; completion_note: string | null;
    cancel_reason: string | null; type_label: string; started_at: string | null;
  };
  events: { id: string; action: string; from_value: string | null; to_value: string | null; note: string | null; reference: string | null; at: string; actor: string }[];
  permitted: { moves: TaskStatus[]; assign: boolean; edit: boolean; comment: boolean; followUp: boolean };
}

export interface StaffOption { id: string; username: string; display_name: string; roles: string[] }

export interface EscalationRow {
  id: string; escalation_no: string; category: string; severity: 'low' | 'medium' | 'high' | 'critical';
  status: 'open' | 'acknowledged' | 'investigating' | 'closed'; responsible_role: string; responsible_level: 'county' | 'national';
  title: string; county_id: number; county_code: string; case_id: string | null; case_no: string | null; upi: string | null;
  created_at: string; updated_at: string; created_by: string; assignee: string | null; responsible: boolean;
}
export interface EscalationDetail {
  escalation: EscalationRow & {
    description: string; evidence: { type: string; reference: string; note?: string }[]; county_name: string; task_no: string | null;
    task_status: string | null; finding_code: string | null; created_by_username: string; closed_at: string | null;
    closed_by_username: string | null; closure_reason: string | null;
  };
  events: { id: string; action: string; from_status: string | null; to_status: string | null; note: string | null; at: string; actor: string }[];
  permitted: {
    acknowledge: boolean; assign: boolean; investigate: boolean; escalate: boolean; comment: boolean; close: boolean;
    targets: { role: string; level: 'county' | 'national' }[];
  };
}

export interface ReportColumn { key: string; label: string; kind: 'value' | 'count' | 'derived' }
export interface ReportResult {
  reportId: string; key: string; title: string; description: string; generatedAt: string; generatedBy: string; scope: string;
  filters: { from: string; to: string; stage: string | null; taskType: string | null; role: string | null };
  dataNotice: string; columns: ReportColumn[]; rows: Record<string, unknown>[];
}

// ---------------------------------------------------------------------------
// GIS officer workspace (server/src/routes/gis.ts and gisWork.ts)
// ---------------------------------------------------------------------------

export type JobStatus = 'queued' | 'running' | 'completed' | 'completed_with_warnings' | 'failed' | 'cancelled';
export interface GisKpis {
  my_open_tasks: number; my_overdue_tasks: number; claimable_tasks: number; cases_in_preparation: number; returned_cases: number;
  cases_with_blocking_errors: number; awaiting_review: number; accepted_30d: number; jobs_active: number; jobs_failed_7d: number;
  versions_7d: number; open_conflicts: number;
}
export interface GisJobSummary { id: string; job_no: string; kind: string; status: JobStatus; source_name: string; created_at: string; case_no: string }
export interface GisSummary {
  kpis: GisKpis;
  lastArcmapSync: { job_no: string; status: JobStatus; finished_at: string | null; created_at: string } | null;
  recentJobs: GisJobSummary[];
  myTasks: { id: string; task_no: string; title: string; status: string; priority: string; due_date: string | null; case_no: string | null }[];
}
export interface GisTask {
  id: string; task_no: string; task_type: string; title: string; description: string | null; status: string; priority: string; due_date: string | null;
  created_at: string; case_id: string | null; case_no: string | null; case_status: string | null; county_code: string; created_by_username: string;
  overdue: boolean; acknowledged_at: string | null; last_clarification: string | null;
}
export interface GisCase {
  id: string; case_no: string; case_type: CaseType; status: string; county_id: number; county_code: string; proposed_upi: string | null; priority: string;
  batch_id: string | null; version_no: number | null; feature_count: number | null; declared_srid: number | null; version_at: string | null;
  error_count: number | null; warning_count: number | null; validated_at: string | null;
}
export interface GisFeatureCollection { type: 'FeatureCollection'; features: { type: 'Feature'; geometry: Geometry; properties: Record<string, unknown> }[] }
export type WorkspaceLayerKey = 'reference' | 'working' | 'submitted' | 'invalid' | 'overlaps' | 'duplicates' | 'boundary';
export interface WorkspaceLayers { layers: Record<WorkspaceLayerKey, GisFeatureCollection>; truncated: boolean; limit: number }
export interface FieldInfo { name: string; type: string }
export interface LayerInfo {
  name: string; featureCount: number; fields: FieldInfo[]; geometryTypes: string[];
  crs: { epsg: number | null; name: string | null; source: 'prj' | 'geojson-crs' | 'none' }; sample: Record<string, unknown>[]; wktColumn?: string | null;
}
export interface UploadInspection {
  uploadKey: string; file: string; size: number; sha256: string; format: string; layers: LayerInfo[]; manifest: Record<string, unknown> | null;
  warnings: string[]; suggestedMapping: Record<string, Record<string, string>>; expiresInHours: number;
}
export interface ImportOptions {
  formats: { format: string; label: string; supported: boolean; reason?: string }[];
  acceptedCrs: { epsg: number; name: string }[];
  targetFields: { key: string; label: string; type: string }[];
  requiredFields: Record<string, string[]>;
  limits: { maxUploadBytes: number; maxFeatures: number };
}
export interface ImportPreview {
  caseNo: string; format: string; layer: string; file: string; sha256: string;
  crs: { detected: number | null; declared: number; exceptionReason: string | null; name: string };
  received: number; accepted: number; rejected: number; withinLimits: boolean; limitLabel: string | null;
  rejections: { record: number; reason: string }[]; warnings: string[]; extent: number[] | null; sample: Record<string, unknown>[];
}
export interface GisJob {
  id: string; job_no: string; kind: 'import' | 'arcmap_sync' | 'correction'; status: JobStatus; county_id: number; county_code: string; case_id: string; case_no: string;
  case_status: string; initiated_by: string; initiated_by_username: string; purpose: string | null; source_name: string; source_format: string;
  source_layer: string | null; source_size_bytes: string | null; source_sha256: string | null; source_crs_detected: number | null; source_crs_declared: number | null;
  crs_exception_reason: string | null; target_crs: number; adapter_version: string | null; source_dataset: string | null; source_version: string | null;
  export_id: string | null; field_mapping: Record<string, string>; records_received: number | null; records_accepted: number | null; records_rejected: number | null;
  records_inserted: number | null; records_updated: number | null; records_unchanged: number | null; warning_count: number; error_summary: string | null;
  batch_id: string | null; version_no: number | null; retry_of: string | null; retry_of_job_no: string | null; created_at: string; started_at: string | null;
  finished_at: string | null; duration_s: string | null;
}
export interface GisJobDetail extends GisJob {
  warnings: string[]; rejections: { record: number; reason: string }[]; manifest: Record<string, unknown> | null;
  diagnostic: { step: string; ok: boolean; detail: string }[]; canRetry: boolean;
}
export interface GisJobList extends Paged<GisJob> { counts: Partial<Record<JobStatus, number>> }
export interface ImportResult { jobId: string; jobNo: string; duplicate: boolean; job: GisJobDetail | null }
export interface SyncToken {
  id: string; label: string; token_hint: string; created_at: string; expires_at: string; last_used_at: string | null; revoked_at: string | null;
  status: 'active' | 'expired' | 'revoked';
}
export interface SyncStatus {
  state: 'not_configured' | 'token_unused' | 'configured'; explanation: string; lastContact: string | null; activeTokens: number; adapterVersion: string;
  last_success: string | null; last_failure: string | null; failed_7d: number; total_7d: number; jobs: GisJob[];
}
export interface SyncDiagnostic { checks: { check: string; ok: boolean; detail: string }[]; acceptedCrs: number[]; endpoint: string }
export interface CaseVersion {
  id: string; version_no: number; status: string; source_kind: string; source_filename: string; declared_srid: number; feature_count: number;
  change_reason: string | null; created_at: string; created_by: string; job_no: string | null; job_id: string | null; parent_version: number | null;
  excluded_count: number; invalid_count: number; submissions: { submissionNo: string; id: string; at: string; outcome: string }[] | null;
}
export interface VersionList { caseNo: string; caseStatus: string; editable: boolean; versions: CaseVersion[] }
export interface VersionChange {
  featureIndex: number; change: 'added' | 'removed' | 'modified' | 'unchanged'; geometryChanged: boolean; maxShiftM: number | null;
  areaFrom: string | null; areaTo: string | null; excludedFrom: boolean | null; excludedTo: boolean | null; attributes: { field: string; from: unknown; to: unknown }[];
}
export interface VersionCompare {
  a: number; b: number; changes: VersionChange[];
  summary: Record<'added' | 'removed' | 'modified' | 'unchanged', number>;
  geometry: { a: GisFeatureCollection; b: GisFeatureCollection };
}
export interface SubmissionCheck {
  caseNo: string; status: string; ready: boolean;
  items: { key: string; label: string; ok: boolean; detail: string; needsAcknowledgement?: boolean; needsExplanation?: boolean }[];
  previous: { id: string; submission_no: string; created_at: string; outcome: string; version_no: number | null } | null;
  returnReason: { notes: string; instructions: string | null; issue_categories: string[]; created_at: string } | null;
  errors: EvalFinding[]; warnings: EvalFinding[]; ruleSetVersion: number | null; boundaryStatus: string | null; canSubmit: boolean;
}
/** A finding straight from validation (not yet stored), as the submission check and the submit refusal return it. */
export interface EvalFinding {
  code: string; severity: Severity; message: string; relatedParcelId?: string | null; relatedCaseId?: string | null; featureIndex?: number | null;
  detail?: Record<string, unknown>;
}
export interface GisSubmission {
  id: string; submission_no: string; case_id: string; case_no: string; case_type: CaseType; county_code: string; created_at: string; submitted_by: string;
  outcome: string; summary: string | null; change_explanation: string | null; outstanding_warnings: string | null; warnings_acknowledged: boolean;
  snapshot_hash: string | null; feature_count: number; version_no: number | null; previous_submission_no: string | null; error_count: number | null;
  warning_count: number | null; rule_set_version: number | null; review_decision: string | null; reviewed_at: string | null; status: string;
}
export interface GisSubmissionDetail extends GisSubmission {
  snapshotIntact: boolean | null; findings: { code: string; severity: Severity; message: string; feature_index: number | null }[];
  reviews: { decision: string; notes: string; instructions: string | null; issue_categories: string[]; affected_features: number[]; created_at: string; reviewer: string }[];
}
export interface ReturnedCase {
  id: string; case_no: string; case_type: CaseType; county_code: string; priority: string; due_date: string | null; returned_at: string | null; return_note: string | null;
  return_action: string | null; returned_by: string | null; review_notes: string | null; instructions: string | null; issue_categories: string[] | null;
  affected_features: number[] | null; reviewer: string | null; error_count: number | null; warning_count: number | null; version_no: number | null; open_task_no: string | null;
}
export interface ValidationFindingRow {
  id: string; code: string; severity: Severity; message: string; feature_index: number | null; acknowledged_at: string | null; rule_label: string | null;
  category: string | null; suggestion: string | null; case_id: string; case_no: string; case_status: string; county_code: string; run_at: string;
  purpose: string; rule_set_version: number | null; run_id: string; extent: Geometry | null;
}
export interface ValidationRule {
  code: string; label: string; category: string; default_severity: Severity; severity: Severity; configurable: boolean; suggestion: string | null;
  updated_by_username: string | null; updated_at: string;
}
export interface RuleSet {
  rules: ValidationRule[]; currentVersion: number | null; canConfigure: boolean;
  history: { version: number; changed_by_username: string | null; changed_at: string; rule_code: string | null; from_value: string | null; to_value: string | null; reason: string }[];
}
