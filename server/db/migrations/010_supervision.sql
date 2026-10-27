-- Supervision: quality review of submissions, operational tasks, escalations and conflict review.
-- None of these tables confers legal authority: case decisions and publication stay with registrars
-- (lais.case_decision, lais.enforce_case_transition). History tables are append-only.

-- A generic guard for append-only history tables.
CREATE FUNCTION lais.forbid_history_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: history cannot be changed or deleted', TG_TABLE_NAME;
END $$;

-- ---------------------------------------------------------------------------
-- Operational fields on cases (outside the decision snapshot; closed cases stay frozen by the
-- existing transition trigger)
-- ---------------------------------------------------------------------------
ALTER TABLE lais.land_case
  ADD COLUMN priority text NOT NULL DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
  ADD COLUMN due_date date;

-- ---------------------------------------------------------------------------
-- Supervisory quality review
-- ---------------------------------------------------------------------------
CREATE TABLE lais.review_issue_category (
  code        text PRIMARY KEY CHECK (code ~ '^[a-z][a-z0-9_]{2,40}$'),
  label       text NOT NULL,
  applies_to  text NOT NULL CHECK (applies_to IN ('gis', 'documents', 'attributes', 'any')),
  active      boolean NOT NULL DEFAULT true
);
INSERT INTO lais.review_issue_category (code, label, applies_to) VALUES
  ('geometry_invalid', 'Invalid or empty geometry', 'gis'),
  ('potential_overlap', 'Potential overlap with a published parcel or another submission', 'gis'),
  ('duplicate_geometry', 'Duplicate geometry', 'gis'),
  ('outside_boundary', 'Outside or crossing the county boundary', 'gis'),
  ('crs_problem', 'Coordinate reference system or axis-order problem', 'gis'),
  ('area_inconsistent', 'Inconsistent parcel area or coverage', 'gis'),
  ('identifier_problem', 'Missing, malformed or duplicate parcel identifier', 'attributes'),
  ('missing_attributes', 'Missing or invalid mandatory attributes', 'attributes'),
  ('documents_incomplete', 'Supporting documents incomplete or unverified', 'documents'),
  ('stale_source', 'Stale or superseded source data', 'any'),
  ('other', 'Other (explained in the instructions)', 'any');

CREATE TABLE lais.supervisory_review (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id            uuid NOT NULL REFERENCES lais.land_case (id),
  county_id          smallint NOT NULL REFERENCES lais.county (id),
  batch_id           uuid REFERENCES staging.batch (id),
  -- The validation run the reviewer looked at. An acceptance is valid only for this run.
  validation_run_id  uuid REFERENCES staging.validation_run (id),
  decision           text NOT NULL CHECK (decision IN ('accepted', 'returned', 'info_requested')),
  issue_categories   text[] NOT NULL DEFAULT '{}',
  affected_features  int[] NOT NULL DEFAULT '{}',
  notes              text NOT NULL CHECK (length(trim(notes)) >= 5),
  instructions       text,
  task_id            uuid,
  case_status        text NOT NULL,
  reviewer_id        uuid NOT NULL REFERENCES lais.app_user (id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  CHECK (decision <> 'returned' OR cardinality(issue_categories) > 0)
);
CREATE INDEX supervisory_review_case_idx ON lais.supervisory_review (case_id, created_at DESC);
CREATE TRIGGER supervisory_review_append_only BEFORE UPDATE OR DELETE ON lais.supervisory_review
  FOR EACH ROW EXECUTE FUNCTION lais.forbid_history_change();

-- ---------------------------------------------------------------------------
-- Operational tasks. A task is a work item only: it grants the assignee no permission.
-- ---------------------------------------------------------------------------
CREATE SEQUENCE lais.task_no_seq;
CREATE TABLE lais.task (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_no          text NOT NULL UNIQUE DEFAULT 'TSK-' || lpad(nextval('lais.task_no_seq')::text, 6, '0'),
  task_type        text NOT NULL CHECK (task_type IN (
                     'document_review', 'gis_preparation', 'gis_validation_correction', 'attribute_verification',
                     'conflict_investigation', 'application_follow_up', 'additional_information',
                     'correction_resubmission', 'quality_review')),
  title            text NOT NULL CHECK (length(trim(title)) BETWEEN 3 AND 200),
  description      text,
  instructions     text,
  reference        text,
  county_id        smallint NOT NULL REFERENCES lais.county (id),
  case_id          uuid REFERENCES lais.land_case (id),
  batch_id         uuid REFERENCES staging.batch (id),
  finding_id       uuid REFERENCES staging.finding (id),
  assignee_id      uuid REFERENCES lais.app_user (id),
  status           text NOT NULL DEFAULT 'unassigned'
                     CHECK (status IN ('unassigned', 'assigned', 'in_progress', 'blocked', 'returned', 'completed', 'cancelled')),
  priority         text NOT NULL DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
  due_date         date,
  notify_assignee  boolean NOT NULL DEFAULT true,
  created_by       uuid NOT NULL REFERENCES lais.app_user (id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  started_at       timestamptz,
  completed_at     timestamptz,
  completion_note  text,
  cancel_reason    text,
  CHECK ((status = 'unassigned') = (assignee_id IS NULL) OR status = 'cancelled'),
  CHECK (status <> 'completed' OR (completed_at IS NOT NULL AND length(trim(completion_note)) >= 5)),
  CHECK (status <> 'cancelled' OR length(trim(cancel_reason)) >= 5)
);
CREATE INDEX task_county_status_idx ON lais.task (county_id, status);
CREATE INDEX task_assignee_idx ON lais.task (assignee_id) WHERE status NOT IN ('completed', 'cancelled');
CREATE INDEX task_case_idx ON lais.task (case_id);

ALTER TABLE lais.supervisory_review ADD FOREIGN KEY (task_id) REFERENCES lais.task (id);

-- Task status transitions, enforced here as well as in the API. Tasks are never deleted.
CREATE FUNCTION lais.enforce_task_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Tasks cannot be deleted; cancel them with a reason';
  END IF;
  IF OLD.status IN ('completed', 'cancelled') AND NEW.status = OLD.status AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'Task % is closed and cannot be changed', OLD.task_no;
  END IF;
  IF NEW.status <> OLD.status AND (OLD.status, NEW.status) NOT IN (
       ('unassigned', 'assigned'), ('unassigned', 'cancelled'),
       ('assigned', 'assigned'), ('assigned', 'in_progress'), ('assigned', 'completed'), ('assigned', 'cancelled'),
       ('in_progress', 'blocked'), ('in_progress', 'completed'), ('in_progress', 'assigned'), ('in_progress', 'cancelled'),
       ('blocked', 'in_progress'), ('blocked', 'assigned'), ('blocked', 'cancelled'),
       ('returned', 'in_progress'), ('returned', 'completed'), ('returned', 'assigned'), ('returned', 'cancelled'),
       ('completed', 'returned')
     ) THEN
    RAISE EXCEPTION 'Illegal task status transition % -> %', OLD.status, NEW.status;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;
CREATE TRIGGER task_transition BEFORE UPDATE OR DELETE ON lais.task
  FOR EACH ROW EXECUTE FUNCTION lais.enforce_task_transition();

-- Every change to a task: creation, assignment and reassignment (with reason), status changes,
-- priority and due-date changes, comments and follow-ups. Covers task assignments and task comments.
CREATE TABLE lais.task_event (
  id          bigserial PRIMARY KEY,
  task_id     uuid NOT NULL REFERENCES lais.task (id),
  actor_id    uuid NOT NULL REFERENCES lais.app_user (id),
  action      text NOT NULL CHECK (action IN (
                'created', 'assigned', 'reassigned', 'status_changed', 'priority_changed', 'due_date_changed',
                'comment', 'follow_up', 'completed', 'returned', 'cancelled')),
  from_value  text,
  to_value    text,
  note        text,
  reference   text,
  at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX task_event_task_idx ON lais.task_event (task_id, id);
CREATE TRIGGER task_event_append_only BEFORE UPDATE OR DELETE ON lais.task_event
  FOR EACH ROW EXECUTE FUNCTION lais.forbid_history_change();

-- ---------------------------------------------------------------------------
-- Escalations
-- ---------------------------------------------------------------------------
CREATE SEQUENCE lais.escalation_no_seq;
CREATE TABLE lais.escalation (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  escalation_no      text NOT NULL UNIQUE DEFAULT 'ESC-' || lpad(nextval('lais.escalation_no_seq')::text, 6, '0'),
  category           text NOT NULL CHECK (category IN (
                       'repeated_quality_failure', 'spatial_conflict', 'suspected_unauthorized_change', 'document_discrepancy',
                       'processing_delay', 'sync_failure', 'access_control_incident', 'workflow_exception')),
  severity           text NOT NULL CHECK (severity IN ('low', 'medium', 'high', 'critical')),
  status             text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'acknowledged', 'investigating', 'closed')),
  -- Who must act on it now. 'national' means a national-level holder of the role.
  responsible_role   text NOT NULL CHECK (responsible_role IN ('supervisor', 'registrar', 'system_admin')),
  responsible_level  text NOT NULL DEFAULT 'county' CHECK (responsible_level IN ('county', 'national')),
  county_id          smallint NOT NULL REFERENCES lais.county (id),
  case_id            uuid REFERENCES lais.land_case (id),
  parcel_id          uuid REFERENCES lais.parcel (id),
  finding_id         uuid REFERENCES staging.finding (id),
  task_id            uuid REFERENCES lais.task (id),
  title              text NOT NULL CHECK (length(trim(title)) BETWEEN 3 AND 200),
  description        text NOT NULL CHECK (length(trim(description)) >= 10),
  evidence           jsonb NOT NULL DEFAULT '[]',
  assignee_id        uuid REFERENCES lais.app_user (id),
  created_by         uuid NOT NULL REFERENCES lais.app_user (id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  closed_at          timestamptz,
  closed_by          uuid REFERENCES lais.app_user (id),
  closure_reason     text,
  CHECK ((status = 'closed') = (closed_at IS NOT NULL)),
  CHECK (status <> 'closed' OR (closed_by IS NOT NULL AND length(trim(closure_reason)) >= 10))
);
CREATE INDEX escalation_county_status_idx ON lais.escalation (county_id, status);

-- Tasks raised to investigate an escalation (an escalation cannot close while one is open).
ALTER TABLE lais.task ADD COLUMN escalation_id uuid REFERENCES lais.escalation (id);

CREATE FUNCTION lais.protect_escalation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Escalations cannot be deleted'; END IF;
  IF OLD.status = 'closed' THEN RAISE EXCEPTION 'Escalation % is closed', OLD.escalation_no; END IF;
  IF (NEW.category, NEW.county_id, NEW.case_id, NEW.parcel_id, NEW.finding_id, NEW.task_id, NEW.description, NEW.evidence, NEW.created_by, NEW.created_at)
     IS DISTINCT FROM (OLD.category, OLD.county_id, OLD.case_id, OLD.parcel_id, OLD.finding_id, OLD.task_id, OLD.description, OLD.evidence, OLD.created_by, OLD.created_at) THEN
    RAISE EXCEPTION 'The facts of an escalation cannot be changed; add an event instead';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;
CREATE TRIGGER escalation_protect BEFORE UPDATE OR DELETE ON lais.escalation
  FOR EACH ROW EXECUTE FUNCTION lais.protect_escalation();

CREATE TABLE lais.escalation_event (
  id             bigserial PRIMARY KEY,
  escalation_id  uuid NOT NULL REFERENCES lais.escalation (id),
  actor_id       uuid NOT NULL REFERENCES lais.app_user (id),
  action         text NOT NULL CHECK (action IN ('opened', 'acknowledged', 'assigned', 'investigation_requested', 'escalated', 'comment', 'closed')),
  from_status    text,
  to_status      text,
  note           text,
  at             timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX escalation_event_idx ON lais.escalation_event (escalation_id, id);
CREATE TRIGGER escalation_event_append_only BEFORE UPDATE OR DELETE ON lais.escalation_event
  FOR EACH ROW EXECUTE FUNCTION lais.forbid_history_change();

-- ---------------------------------------------------------------------------
-- Spatial conflict review. Conflicts are validation findings (staging.finding); this records what
-- supervisors did about them. Findings themselves are never edited or deleted here.
-- ---------------------------------------------------------------------------
CREATE TABLE lais.conflict_rule (
  code          text PRIMARY KEY,
  category      text NOT NULL,
  label         text NOT NULL,
  method        text NOT NULL,
  rule_version  text NOT NULL DEFAULT '1'
);
INSERT INTO lais.conflict_rule (code, category, label, method) VALUES
  ('OVERLAP_PUBLISHED_PARCEL', 'potential_overlap', 'Potential parcel overlap', 'PostGIS ST_Intersects, area of ST_Intersection (geography) above OVERLAP_TOLERANCE_M2; touching boundaries excluded'),
  ('NEW_PARCELS_OVERLAP', 'potential_overlap', 'Potential parcel overlap', 'Pairwise ST_Intersection area of new parcels above tolerance'),
  ('MIGRATION_INTERNAL_OVERLAP', 'potential_overlap', 'Potential parcel overlap', 'Pairwise ST_Intersection area within the migration batch above tolerance'),
  ('DUPLICATE_UPI', 'duplicate_identifier', 'Duplicate parcel identifier', 'Proposed identifier already used by a published parcel'),
  ('UPI_IN_OTHER_OPEN_CASE', 'duplicate_identifier', 'Duplicate parcel identifier', 'Proposed identifier also proposed in another open case'),
  ('DUPLICATE_LEGACY_REF', 'duplicate_identifier', 'Duplicate parcel identifier', 'Same legacy reference on several features of a batch'),
  ('DUPLICATE_GEOMETRY_SUSPECTED', 'duplicate_geometry', 'Duplicate geometry', 'Hausdorff distance to a published parcel within DUPLICATE_HAUSDORFF_M (UTM 29N)'),
  ('GEOMETRY_INVALID', 'invalid_geometry', 'Invalid or empty geometry', 'ST_IsValid on import; geometry kept as received, never repaired'),
  ('NO_GEOMETRY', 'invalid_geometry', 'Invalid or empty geometry', 'No geometry imported'),
  ('OUTSIDE_CASE_COUNTY', 'outside_boundary', 'Outside the county boundary', 'ST_CoveredBy county boundary (indicative unless the boundary is verified)'),
  ('CROSSES_COUNTY_BOUNDARY', 'outside_boundary', 'Outside the county boundary', 'ST_Intersects but not ST_CoveredBy county boundary (indicative unless verified)'),
  ('OUTSIDE_NATIONAL_EXTENT', 'outside_boundary', 'Outside the county boundary', 'Centroid outside the approximate national extent: likely wrong CRS'),
  ('AREA_UNUSUALLY_SMALL', 'area_inconsistent', 'Inconsistent parcel area', 'Geodesic area below MIN_PARCEL_AREA_M2'),
  ('COVERAGE_GAP', 'area_inconsistent', 'Inconsistent parcel area', 'New parcels leave part of the source area uncovered'),
  ('COVERAGE_EXCEEDS_SOURCE', 'area_inconsistent', 'Inconsistent parcel area', 'New parcels extend beyond the source area'),
  ('SIGNIFICANT_BOUNDARY_CHANGE', 'area_inconsistent', 'Inconsistent parcel area', 'Corrected boundary moves or changes area beyond the configured thresholds'),
  ('CONFLICTING_OPEN_SUBMISSION', 'duplicate_application', 'Suspected duplicate application', 'Overlaps geometry proposed in another open case'),
  ('PARCEL_IN_OTHER_OPEN_CASE', 'duplicate_application', 'Suspected duplicate application', 'The parcel is already the subject of another open case'),
  ('LEGACY_ATTRIBUTE_INVALID', 'conflicting_attributes', 'Conflicting attribute records', 'Legacy attributes missing or invalid'),
  ('ALREADY_MIGRATED', 'conflicting_attributes', 'Conflicting attribute records', 'Legacy reference already migrated to a published parcel'),
  ('AXIS_ORDER_SWAPPED_SUSPECTED', 'geometry_discrepancy', 'Unresolved geometry discrepancy', 'Centroid matches Liberia with latitude and longitude swapped');

CREATE TABLE lais.conflict_review_event (
  id             bigserial PRIMARY KEY,
  finding_id     uuid NOT NULL REFERENCES staging.finding (id),
  case_id        uuid NOT NULL REFERENCES lais.land_case (id),
  action         text NOT NULL CHECK (action IN ('note', 'investigation_assigned', 'gis_check_requested', 'returned_for_correction', 'escalated')),
  note           text NOT NULL CHECK (length(trim(note)) >= 5),
  task_id        uuid REFERENCES lais.task (id),
  escalation_id  uuid REFERENCES lais.escalation (id),
  actor_id       uuid NOT NULL REFERENCES lais.app_user (id),
  at             timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX conflict_review_event_idx ON lais.conflict_review_event (finding_id, id);
CREATE TRIGGER conflict_review_event_append_only BEFORE UPDATE OR DELETE ON lais.conflict_review_event
  FOR EACH ROW EXECUTE FUNCTION lais.forbid_history_change();

-- ---------------------------------------------------------------------------
-- Settings for this phase. Both are operational choices for the administrator, not legal rules.
-- ---------------------------------------------------------------------------
INSERT INTO lais.system_setting (key, value, description) VALUES
  ('workflow.supervisor_review', '"optional"',
   'Whether a registrar may approve a case only after a supervisor has accepted its current validation results ("required") or not ("optional")'),
  ('workflow.stage_targets_days', 'null',
   'Operational target days per workflow stage, e.g. {"draft": 14, "under_review": 7}. Internal targets, not statutory deadlines; null means not configured');

-- Notification categories for tasks and escalations.
ALTER TABLE lais.notification DROP CONSTRAINT notification_category_check;
ALTER TABLE lais.notification ADD CONSTRAINT notification_category_check
  CHECK (category IN ('account', 'security', 'workflow', 'gis', 'system', 'task', 'escalation', 'review'));
