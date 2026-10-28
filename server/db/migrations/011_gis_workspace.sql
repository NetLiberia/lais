-- GIS Officer workspace: import and synchronization jobs, working versions, immutable submission
-- snapshots, configurable validation rules and ArcMap sync tokens. Staging data is never authoritative:
-- geometry reaches lais.parcel_version only through publication of an approved case.

-- ---------------------------------------------------------------------------
-- Import and synchronization jobs
-- ---------------------------------------------------------------------------
CREATE SEQUENCE staging.import_job_no_seq;
CREATE TABLE staging.import_job (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_no                text NOT NULL UNIQUE DEFAULT 'GIS-' || lpad(nextval('staging.import_job_no_seq')::text, 6, '0'),
  kind                  text NOT NULL CHECK (kind IN ('import', 'arcmap_sync', 'correction')),
  status                text NOT NULL DEFAULT 'queued'
                          CHECK (status IN ('queued', 'running', 'completed', 'completed_with_warnings', 'failed', 'cancelled')),
  county_id             smallint NOT NULL REFERENCES lais.county (id),
  case_id               uuid NOT NULL REFERENCES lais.land_case (id),
  initiated_by          uuid NOT NULL REFERENCES lais.app_user (id),
  purpose               text,
  source_name           text NOT NULL,
  source_format         text NOT NULL CHECK (source_format IN ('geojson', 'shapefile', 'csv_wkt', 'arcmap_package', 'working_copy')),
  source_layer          text,
  source_size_bytes     bigint,
  source_sha256         text,
  -- What the file says, what the officer declared, and why an unknown CRS was accepted (if it was).
  source_crs_detected   integer,
  source_crs_declared   integer,
  crs_exception_reason  text,
  target_crs            integer NOT NULL DEFAULT 4326,
  -- ArcMap: the adapter's version, the dataset it read and its export identifier (unique per case).
  adapter_version       text,
  source_dataset        text,
  source_version        text,
  export_id             text,
  manifest              jsonb,
  field_mapping         jsonb NOT NULL DEFAULT '{}',
  upload_key            text,
  records_received      integer,
  records_accepted      integer,
  records_rejected      integer,
  records_inserted      integer,
  records_updated       integer,
  records_unchanged     integer,
  warnings              jsonb NOT NULL DEFAULT '[]',
  rejections            jsonb NOT NULL DEFAULT '[]',
  error_summary         text,
  batch_id              uuid REFERENCES staging.batch (id),
  retry_of              uuid REFERENCES staging.import_job (id),
  created_at            timestamptz NOT NULL DEFAULT now(),
  started_at            timestamptz,
  finished_at           timestamptz,
  CHECK (status NOT IN ('completed', 'completed_with_warnings') OR batch_id IS NOT NULL),
  CHECK (source_crs_declared IS NOT NULL OR status IN ('queued', 'failed', 'cancelled')),
  CHECK (source_crs_detected IS NOT NULL OR source_crs_declared IS NULL OR crs_exception_reason IS NOT NULL OR status IN ('queued', 'failed', 'cancelled'))
);
CREATE INDEX import_job_county_idx ON staging.import_job (county_id, created_at DESC);
CREATE INDEX import_job_case_idx ON staging.import_job (case_id, created_at DESC);
-- One successful processing of an ArcMap export per case: a resend is answered with the earlier job.
CREATE UNIQUE INDEX import_job_export_uq ON staging.import_job (case_id, export_id)
  WHERE export_id IS NOT NULL AND status IN ('completed', 'completed_with_warnings');

-- ---------------------------------------------------------------------------
-- Working versions: every staging batch is a numbered version of the case geometry
-- ---------------------------------------------------------------------------
ALTER TABLE staging.batch
  ADD COLUMN version_no      integer,
  ADD COLUMN source_kind     text NOT NULL DEFAULT 'upload' CHECK (source_kind IN ('upload', 'arcmap', 'correction')),
  ADD COLUMN job_id          uuid REFERENCES staging.import_job (id),
  ADD COLUMN parent_batch_id uuid REFERENCES staging.batch (id),
  ADD COLUMN change_reason   text;
UPDATE staging.batch b SET version_no = v.n
  FROM (SELECT id, row_number() OVER (PARTITION BY case_id ORDER BY created_at, id) AS n FROM staging.batch) v
 WHERE v.id = b.id;
ALTER TABLE staging.batch ALTER COLUMN version_no SET NOT NULL;
CREATE UNIQUE INDEX batch_version_uq ON staging.batch (case_id, version_no);

-- ---------------------------------------------------------------------------
-- Submissions: immutable snapshots of exactly what was sent for review
-- ---------------------------------------------------------------------------
CREATE SEQUENCE staging.submission_no_seq;
CREATE TABLE staging.submission (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  submission_no           text NOT NULL UNIQUE DEFAULT 'SUB-' || lpad(nextval('staging.submission_no_seq')::text, 6, '0'),
  case_id                 uuid NOT NULL REFERENCES lais.land_case (id),
  batch_id                uuid REFERENCES staging.batch (id),
  validation_run_id       uuid NOT NULL REFERENCES staging.validation_run (id),
  submitted_by            uuid NOT NULL REFERENCES lais.app_user (id),
  outcome                 text NOT NULL CHECK (outcome IN ('under_review', 'returned_by_validation')),
  summary                 text,
  change_explanation      text,
  outstanding_warnings    text,
  warnings_acknowledged   boolean NOT NULL DEFAULT false,
  -- Hash of the submitted features (geometry and attributes) at the moment of submission.
  snapshot_hash           text,
  feature_count           integer NOT NULL DEFAULT 0,
  previous_submission_id  uuid REFERENCES staging.submission (id),
  created_at              timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX submission_case_idx ON staging.submission (case_id, created_at DESC);
CREATE TRIGGER submission_append_only BEFORE UPDATE OR DELETE ON staging.submission
  FOR EACH ROW EXECUTE FUNCTION lais.forbid_history_change();

-- The features of a submitted version are frozen: further work needs a new working version.
-- Publication may still record which parcel each feature became.
CREATE FUNCTION staging.protect_submitted_features() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM staging.submission s WHERE s.batch_id = OLD.batch_id) THEN
    IF TG_OP = 'DELETE' OR (to_jsonb(NEW) - 'published_parcel_id') IS DISTINCT FROM (to_jsonb(OLD) - 'published_parcel_id') THEN
      RAISE EXCEPTION 'Version % was submitted for review and cannot be changed; create a new working version', OLD.batch_id;
    END IF;
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$;
CREATE TRIGGER feature_submitted_protect BEFORE UPDATE OR DELETE ON staging.feature
  FOR EACH ROW EXECUTE FUNCTION staging.protect_submitted_features();

-- ---------------------------------------------------------------------------
-- Configurable validation rules, with a versioned history
-- ---------------------------------------------------------------------------
CREATE TABLE staging.validation_rule (
  code              text PRIMARY KEY,
  label             text NOT NULL,
  category          text NOT NULL CHECK (category IN ('geometry', 'spatial', 'boundary', 'identifier', 'attribute', 'completeness', 'rights', 'workflow')),
  default_severity  text NOT NULL CHECK (default_severity IN ('error', 'warning')),
  severity          text NOT NULL CHECK (severity IN ('error', 'warning')),
  -- Safety rules (invalid geometry, wrong CRS, missing evidence...) are fixed; others can be tuned.
  configurable      boolean NOT NULL DEFAULT false,
  suggestion        text,
  updated_by        uuid REFERENCES lais.app_user (id),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CHECK (configurable OR severity = default_severity)
);
CREATE TABLE staging.rule_set_version (
  version      serial PRIMARY KEY,
  changed_by   uuid REFERENCES lais.app_user (id),
  changed_at   timestamptz NOT NULL DEFAULT now(),
  rule_code    text,
  from_value   text,
  to_value     text,
  reason       text NOT NULL
);
CREATE TRIGGER rule_set_version_append_only BEFORE UPDATE OR DELETE ON staging.rule_set_version
  FOR EACH ROW EXECUTE FUNCTION lais.forbid_history_change();
INSERT INTO staging.rule_set_version (reason) VALUES ('Initial rule set (migration 011)');

INSERT INTO staging.validation_rule (code, label, category, default_severity, severity, configurable, suggestion) VALUES
  ('GEOMETRY_INVALID', 'Invalid geometry', 'geometry', 'error', 'error', false, 'Fix the geometry in the GIS tool (self-intersections, rings) and re-import. The system never repairs geometry.'),
  ('NO_GEOMETRY', 'No geometry imported', 'geometry', 'error', 'error', false, 'Import the parcel geometry for this case.'),
  ('AXIS_ORDER_SWAPPED_SUSPECTED', 'Latitude and longitude swapped', 'geometry', 'error', 'error', false, 'Export with longitude first (x = longitude) or declare the correct CRS.'),
  ('OUTSIDE_NATIONAL_EXTENT', 'Outside Liberia', 'boundary', 'error', 'error', false, 'Check the declared coordinate reference system.'),
  ('OUTSIDE_CASE_COUNTY', 'Outside the case county', 'boundary', 'error', 'error', false, 'Check the county of the case or the geometry.'),
  ('CROSSES_COUNTY_BOUNDARY', 'Crosses the county boundary', 'boundary', 'error', 'error', false, 'Split the parcel at the county boundary or check its position.'),
  ('AREA_UNUSUALLY_SMALL', 'Unusually small parcel', 'geometry', 'warning', 'warning', true, 'Check for slivers or a wrong unit of measure.'),
  ('AREA_UNUSUALLY_LARGE', 'Unusually large parcel', 'geometry', 'warning', 'warning', true, 'Check for a wrong CRS, unit or merged features.'),
  ('MULTIPART_GEOMETRY', 'Multipart parcel', 'geometry', 'warning', 'warning', true, 'Confirm the parcel really consists of separate parts, or split it.'),
  ('OVERLAP_PUBLISHED_PARCEL', 'Overlaps a published parcel', 'spatial', 'warning', 'warning', true, 'Compare with the published parcel and the survey plan; correct the boundary if it is a digitising error.'),
  ('DUPLICATE_GEOMETRY_SUSPECTED', 'Nearly identical to a published parcel', 'spatial', 'warning', 'warning', true, 'Check whether this parcel is already registered.'),
  ('CONFLICTING_OPEN_SUBMISSION', 'Overlaps another open submission', 'spatial', 'warning', 'warning', true, 'Coordinate with the officer of the other case.'),
  ('NEW_PARCELS_OVERLAP', 'New parcels overlap each other', 'spatial', 'error', 'error', false, 'Correct the shared boundaries of the new parcels.'),
  ('MIGRATION_INTERNAL_OVERLAP', 'Overlap inside the migration batch', 'spatial', 'warning', 'warning', true, 'Correct or exclude one of the overlapping features.'),
  ('COVERAGE_GAP', 'New parcels leave a gap', 'spatial', 'error', 'error', false, 'Make the new parcels cover the whole source parcel.'),
  ('COVERAGE_EXCEEDS_SOURCE', 'New parcels exceed the source', 'spatial', 'error', 'error', false, 'Keep the new parcels inside the source parcel.'),
  ('SIGNIFICANT_BOUNDARY_CHANGE', 'Significant boundary change', 'spatial', 'warning', 'warning', true, 'Attach a survey plan explaining the change.'),
  ('UPI_FORMAT_INVALID', 'Malformed parcel identifier', 'identifier', 'error', 'error', false, 'Use the pattern PROV-XX-000000.'),
  ('DUPLICATE_UPI', 'Identifier already published', 'identifier', 'error', 'error', false, 'Choose another identifier or check for a duplicate registration.'),
  ('UPI_IN_OTHER_OPEN_CASE', 'Identifier proposed in another case', 'identifier', 'warning', 'warning', true, 'Coordinate with the other case.'),
  ('DUPLICATE_LEGACY_REF', 'Duplicate legacy reference', 'identifier', 'error', 'error', false, 'Give each feature its own legacy reference or exclude duplicates.'),
  ('DUPLICATE_SOURCE_ID', 'Duplicate source feature identifier', 'identifier', 'warning', 'warning', true, 'Each feature should carry its own source identifier.'),
  ('LEGACY_ATTRIBUTE_INVALID', 'Invalid legacy attributes', 'attribute', 'error', 'error', false, 'Correct the attribute in the source data or exclude the feature.'),
  ('LAND_CATEGORY_MISSING', 'Land category missing', 'attribute', 'error', 'error', false, 'Record the land category on the case.'),
  ('SOURCE_REFERENCE_MISSING', 'Source reference missing', 'attribute', 'error', 'error', false, 'Record the survey or source reference.');

ALTER TABLE staging.validation_run
  ADD COLUMN rule_set_version integer REFERENCES staging.rule_set_version (version),
  ADD COLUMN boundary_status  text;

-- ---------------------------------------------------------------------------
-- ArcMap sync tokens: personal, hashed, usable only on the sync endpoint
-- ---------------------------------------------------------------------------
CREATE TABLE lais.sync_token (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES lais.app_user (id),
  label         text NOT NULL CHECK (length(trim(label)) BETWEEN 3 AND 80),
  token_hash    bytea NOT NULL UNIQUE,
  token_hint    text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  last_used_at  timestamptz,
  revoked_at    timestamptz
);
CREATE INDEX sync_token_user_idx ON lais.sync_token (user_id);

-- Task and conflict actions used by GIS officers.
ALTER TABLE lais.task_event DROP CONSTRAINT task_event_action_check;
ALTER TABLE lais.task_event ADD CONSTRAINT task_event_action_check CHECK (action IN (
  'created', 'assigned', 'reassigned', 'status_changed', 'priority_changed', 'due_date_changed',
  'comment', 'follow_up', 'completed', 'returned', 'cancelled', 'acknowledged', 'clarification_requested', 'claimed'));
ALTER TABLE lais.conflict_review_event DROP CONSTRAINT conflict_review_event_action_check;
ALTER TABLE lais.conflict_review_event ADD CONSTRAINT conflict_review_event_action_check CHECK (action IN (
  'note', 'investigation_assigned', 'gis_check_requested', 'returned_for_correction', 'escalated', 'findings_submitted', 'revalidated'));
