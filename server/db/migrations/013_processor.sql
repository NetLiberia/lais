-- Processor phase: applicants, configurable application categories and requirements, application
-- intake fields on cases, document numbers, versions and administrative review, information requests,
-- GIS handoffs, completeness exceptions and administrative notes.
--
-- Administrative completeness is NOT legal verification: nothing here sets a decision, approves a title
-- or verifies an identity. Every history table is append-only.

-- ---------------------------------------------------------------------------
-- Applicants: the people or bodies who submit applications (administrative contacts). They are kept
-- separate from lais.party, the legal right holders, and can be linked to a verified party later.
-- ---------------------------------------------------------------------------
CREATE SEQUENCE lais.applicant_no_seq;
CREATE TABLE lais.applicant (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  applicant_no          text NOT NULL UNIQUE DEFAULT 'APL-' || lpad(nextval('lais.applicant_no_seq')::text, 6, '0'),
  applicant_type        text NOT NULL CHECK (applicant_type IN ('person', 'organization', 'community', 'government')),
  name                  text NOT NULL CHECK (length(trim(name)) BETWEEN 2 AND 200),
  phone                 text CHECK (phone IS NULL OR phone ~ '^\+?[0-9 ()-]{6,24}$'),
  email                 text CHECK (email IS NULL OR email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  address               text CHECK (address IS NULL OR length(address) <= 500),
  -- Identification: only the document type and a reference, when the process requires it. Restricted.
  id_document_type      text CHECK (id_document_type IS NULL OR id_document_type IN ('national_id', 'passport', 'voter_card', 'drivers_licence', 'registration_certificate', 'other')),
  id_reference          text CHECK (id_reference IS NULL OR length(id_reference) <= 60),
  representative_name   text CHECK (representative_name IS NULL OR length(representative_name) <= 200),
  representative_role   text CHECK (representative_role IS NULL OR length(representative_role) <= 100),
  representative_phone  text CHECK (representative_phone IS NULL OR representative_phone ~ '^\+?[0-9 ()-]{6,24}$'),
  county_id             smallint NOT NULL REFERENCES lais.county (id),
  status                text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  party_id              uuid REFERENCES lais.party (id),
  created_by            uuid NOT NULL REFERENCES lais.app_user (id),
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_by            uuid REFERENCES lais.app_user (id),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  is_synthetic          boolean NOT NULL DEFAULT false
);
CREATE INDEX applicant_county_idx ON lais.applicant (county_id, created_at DESC);
CREATE INDEX applicant_name_idx ON lais.applicant (lower(name));

-- Every change to an applicant record: previous value, new value, reason, who and when. Append-only.
CREATE TABLE lais.applicant_change (
  id            bigserial PRIMARY KEY,
  applicant_id  uuid NOT NULL REFERENCES lais.applicant (id),
  field         text NOT NULL,
  old_value     text,
  new_value     text,
  reason        text,
  changed_by    uuid NOT NULL REFERENCES lais.app_user (id),
  changed_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX applicant_change_idx ON lais.applicant_change (applicant_id, id);
CREATE TRIGGER applicant_change_append_only BEFORE UPDATE OR DELETE ON lais.applicant_change
  FOR EACH ROW EXECUTE FUNCTION lais.forbid_history_change();
CREATE TRIGGER applicant_no_delete BEFORE DELETE ON lais.applicant
  FOR EACH ROW EXECUTE FUNCTION lais.forbid_history_change();

-- ---------------------------------------------------------------------------
-- Application categories and their requirements (administrator-configured). Each category runs on one
-- of the case workflows. The seeded rows are working defaults, NOT a statutory list.
-- ---------------------------------------------------------------------------
CREATE TABLE lais.application_category (
  code         text PRIMARY KEY CHECK (code ~ '^[a-z][a-z0-9_]{2,40}$'),
  label        text NOT NULL CHECK (length(trim(label)) BETWEEN 3 AND 120),
  description  text,
  case_type    text NOT NULL CHECK (case_type IN ('first_registration', 'transfer', 'subdivision', 'consolidation', 'correction', 'migration', 'confirmation')),
  active       boolean NOT NULL DEFAULT true,
  sort_order   integer NOT NULL DEFAULT 100,
  updated_by   uuid REFERENCES lais.app_user (id),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
INSERT INTO lais.application_category (code, label, description, case_type, sort_order) VALUES
  ('first_registration', 'First registration of a parcel', 'Workflow default; configure for official use', 'first_registration', 10),
  ('transfer', 'Transfer of a registered interest', 'Workflow default; configure for official use', 'transfer', 20),
  ('subdivision', 'Subdivision of a parcel', 'Workflow default; configure for official use', 'subdivision', 30),
  ('consolidation', 'Consolidation of parcels', 'Workflow default; configure for official use', 'consolidation', 40),
  ('correction', 'Correction of a registered parcel', 'Workflow default; configure for official use', 'correction', 50),
  ('confirmation', 'Confirmation of documented interests', 'Workflow default; configure for official use', 'confirmation', 60),
  ('migration', 'Legacy register migration', 'Workflow default; configure for official use', 'migration', 70);

CREATE TABLE lais.application_requirement (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  category_code    text NOT NULL REFERENCES lais.application_category (code),
  kind             text NOT NULL CHECK (kind IN ('field', 'document')),
  field_key        text CHECK (field_key IS NULL OR field_key IN (
                     'applicant', 'purpose', 'submission_date', 'receiving_office', 'declared_parcel_ref', 'title_deed_ref',
                     'location_description', 'district', 'locality', 'declared_land_use', 'declared_area', 'survey_reference')),
  doc_category     text REFERENCES lais.document_category (code),
  mandatory        boolean NOT NULL DEFAULT true,
  -- Optional condition: the requirement applies only when this application field has this value.
  condition_field  text CHECK (condition_field IS NULL OR condition_field IN ('declared_area_unit', 'receiving_office', 'title_deed_ref_present', 'survey_reference_present')),
  condition_value  text,
  -- The stage by which it must be met: registration, GIS handoff, or submission for review.
  stage            text NOT NULL DEFAULT 'gis_handoff' CHECK (stage IN ('registration', 'gis_handoff', 'submission')),
  note             text,
  active           boolean NOT NULL DEFAULT true,
  updated_by       uuid REFERENCES lais.app_user (id),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CHECK ((kind = 'field') = (field_key IS NOT NULL)),
  CHECK ((kind = 'document') = (doc_category IS NOT NULL)),
  CHECK ((condition_field IS NULL) = (condition_value IS NULL))
);
CREATE UNIQUE INDEX application_requirement_uq ON lais.application_requirement (category_code, kind, coalesce(field_key, doc_category), coalesce(condition_field, ''), coalesce(condition_value, ''));

-- Working defaults (to be replaced by the authority's checklist).
INSERT INTO lais.application_requirement (category_code, kind, field_key, stage, note)
SELECT c.code, 'field', f.key, f.stage, 'Working default'
  FROM lais.application_category c
  CROSS JOIN (VALUES ('applicant', 'registration'), ('purpose', 'registration'), ('submission_date', 'registration'),
                     ('receiving_office', 'registration'), ('location_description', 'gis_handoff')) AS f(key, stage)
 WHERE c.code <> 'migration';
INSERT INTO lais.application_requirement (category_code, kind, field_key, stage, note)
SELECT c.code, 'field', 'declared_parcel_ref', 'registration', 'Working default: the parcel the application concerns'
  FROM lais.application_category c WHERE c.code IN ('transfer', 'subdivision', 'consolidation', 'correction', 'confirmation');
INSERT INTO lais.application_requirement (category_code, kind, doc_category, stage, note) VALUES
  ('first_registration', 'document', 'survey_plan', 'gis_handoff', 'Working default'),
  ('first_registration', 'document', 'id_document', 'submission', 'Working default'),
  ('first_registration', 'document', 'deed', 'submission', 'Working default'),
  ('transfer', 'document', 'deed', 'submission', 'Working default'),
  ('transfer', 'document', 'id_document', 'submission', 'Working default'),
  ('subdivision', 'document', 'survey_plan', 'gis_handoff', 'Working default'),
  ('consolidation', 'document', 'survey_plan', 'gis_handoff', 'Working default'),
  ('correction', 'document', 'survey_plan', 'gis_handoff', 'Working default'),
  ('confirmation', 'document', 'id_document', 'submission', 'Working default');
INSERT INTO lais.application_requirement (category_code, kind, doc_category, mandatory, stage, note) VALUES
  ('first_registration', 'document', 'customary_certificate', false, 'submission', 'Optional: customary land'),
  ('transfer', 'document', 'power_of_attorney', false, 'submission', 'Optional: when a representative acts');

-- Configuration changes are versioned for review. Append-only.
CREATE TABLE lais.application_config_change (
  id          bigserial PRIMARY KEY,
  entity      text NOT NULL CHECK (entity IN ('category', 'requirement')),
  entity_key  text NOT NULL,
  change      jsonb NOT NULL,
  reason      text NOT NULL CHECK (length(trim(reason)) >= 5),
  changed_by  uuid NOT NULL REFERENCES lais.app_user (id),
  changed_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER application_config_change_append_only BEFORE UPDATE OR DELETE ON lais.application_config_change
  FOR EACH ROW EXECUTE FUNCTION lais.forbid_history_change();

-- ---------------------------------------------------------------------------
-- Applications are cases: intake fields, applicant, category and the responsible processor.
-- Applicant-provided parcel information is "declared" and stays unverified; it never becomes geometry.
-- ---------------------------------------------------------------------------
ALTER TABLE lais.land_case
  ADD COLUMN applicant_id           uuid REFERENCES lais.applicant (id),
  ADD COLUMN category_code          text REFERENCES lais.application_category (code),
  ADD COLUMN intake_status          text NOT NULL DEFAULT 'registered' CHECK (intake_status IN ('draft', 'registered')),
  ADD COLUMN purpose                text CHECK (purpose IS NULL OR length(purpose) <= 1000),
  ADD COLUMN submission_date        date,
  ADD COLUMN receiving_office       text CHECK (receiving_office IS NULL OR length(receiving_office) <= 120),
  -- The receiving office's own receipt number: unique among live applications of a county.
  ADD COLUMN external_reference     text CHECK (external_reference IS NULL OR external_reference ~ '^[A-Za-z0-9/._-]{2,60}$'),
  ADD COLUMN declared_parcel_ref    text CHECK (declared_parcel_ref IS NULL OR length(declared_parcel_ref) <= 80),
  ADD COLUMN title_deed_ref         text CHECK (title_deed_ref IS NULL OR length(title_deed_ref) <= 120),
  ADD COLUMN location_description   text CHECK (location_description IS NULL OR length(location_description) <= 2000),
  ADD COLUMN district               text CHECK (district IS NULL OR length(district) <= 120),
  ADD COLUMN locality               text CHECK (locality IS NULL OR length(locality) <= 120),
  ADD COLUMN declared_land_use      text CHECK (declared_land_use IS NULL OR length(declared_land_use) <= 200),
  ADD COLUMN declared_area          numeric(14, 4) CHECK (declared_area IS NULL OR declared_area > 0),
  ADD COLUMN declared_area_unit     text CHECK (declared_area_unit IS NULL OR declared_area_unit IN ('m2', 'ha', 'acre')),
  ADD COLUMN survey_reference       text CHECK (survey_reference IS NULL OR length(survey_reference) <= 120),
  ADD COLUMN remarks                text CHECK (remarks IS NULL OR length(remarks) <= 2000),
  ADD COLUMN assigned_processor_id  uuid REFERENCES lais.app_user (id),
  ADD CONSTRAINT land_case_area_unit CHECK ((declared_area IS NULL) = (declared_area_unit IS NULL));
CREATE UNIQUE INDEX land_case_external_reference_uq ON lais.land_case (county_id, lower(external_reference))
  WHERE external_reference IS NOT NULL AND status <> 'withdrawn';
CREATE INDEX land_case_applicant_idx ON lais.land_case (applicant_id);
CREATE INDEX land_case_processor_idx ON lais.land_case (assigned_processor_id) WHERE assigned_processor_id IS NOT NULL;
UPDATE lais.land_case SET category_code = case_type WHERE category_code IS NULL;

-- Intake fields are frozen once a case is decided or withdrawn (the responsible processor may change).
CREATE FUNCTION lais.protect_application_fields() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status IN ('approved', 'published', 'rejected', 'withdrawn')
     AND (NEW.applicant_id, NEW.category_code, NEW.purpose, NEW.submission_date, NEW.receiving_office, NEW.external_reference,
          NEW.declared_parcel_ref, NEW.title_deed_ref, NEW.location_description, NEW.district, NEW.locality, NEW.declared_land_use,
          NEW.declared_area, NEW.declared_area_unit, NEW.survey_reference, NEW.remarks)
         IS DISTINCT FROM
         (OLD.applicant_id, OLD.category_code, OLD.purpose, OLD.submission_date, OLD.receiving_office, OLD.external_reference,
          OLD.declared_parcel_ref, OLD.title_deed_ref, OLD.location_description, OLD.district, OLD.locality, OLD.declared_land_use,
          OLD.declared_area, OLD.declared_area_unit, OLD.survey_reference, OLD.remarks) THEN
    RAISE EXCEPTION 'Application % is % and its details can no longer be changed', OLD.case_no, OLD.status;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER land_case_application_protect BEFORE UPDATE ON lais.land_case
  FOR EACH ROW EXECUTE FUNCTION lais.protect_application_fields();

-- The case history is append-only, and cases are never deleted.
CREATE TRIGGER case_event_append_only BEFORE UPDATE OR DELETE ON lais.case_event
  FOR EACH ROW EXECUTE FUNCTION lais.forbid_history_change();
CREATE TRIGGER land_case_no_delete BEFORE DELETE ON lais.land_case
  FOR EACH ROW EXECUTE FUNCTION lais.forbid_history_change();

-- Possible duplicates reviewed at registration: who looked, which application it resembled, and why it
-- was registered anyway. Append-only.
CREATE TABLE lais.application_duplicate_review (
  id                bigserial PRIMARY KEY,
  case_id           uuid NOT NULL REFERENCES lais.land_case (id),
  similar_case_id   uuid NOT NULL REFERENCES lais.land_case (id),
  match_reason      text NOT NULL,
  reason            text NOT NULL CHECK (length(trim(reason)) >= 10),
  reviewed_by       uuid NOT NULL REFERENCES lais.app_user (id),
  reviewed_at       timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER application_duplicate_review_append_only BEFORE UPDATE OR DELETE ON lais.application_duplicate_review
  FOR EACH ROW EXECUTE FUNCTION lais.forbid_history_change();

-- ---------------------------------------------------------------------------
-- Documents: numbers, titles, versions and administrative review
-- ---------------------------------------------------------------------------
CREATE SEQUENCE lais.document_no_seq;
ALTER TABLE lais.document
  ADD COLUMN document_no         text,
  ADD COLUMN title               text CHECK (title IS NULL OR length(title) <= 200),
  ADD COLUMN description         text CHECK (description IS NULL OR length(description) <= 1000),
  ADD COLUMN version_no          integer NOT NULL DEFAULT 1 CHECK (version_no > 0),
  ADD COLUMN supersedes_id       uuid REFERENCES lais.document (id),
  ADD COLUMN replacement_reason  text,
  -- Administrative review (completeness, readability, consistency). Not legal validity.
  ADD COLUMN review_status       text NOT NULL DEFAULT 'not_reviewed' CHECK (review_status IN (
    'not_reviewed', 'under_review', 'accepted', 'incomplete', 'unreadable', 'inconsistent', 'requires_clarification', 'superseded')),
  ADD CONSTRAINT document_replacement_reason CHECK (supersedes_id IS NULL OR length(trim(replacement_reason)) >= 5);
UPDATE lais.document SET document_no = 'DOC-' || lpad(nextval('lais.document_no_seq')::text, 6, '0') WHERE document_no IS NULL;
ALTER TABLE lais.document ALTER COLUMN document_no SET DEFAULT 'DOC-' || lpad(nextval('lais.document_no_seq')::text, 6, '0');
ALTER TABLE lais.document ALTER COLUMN document_no SET NOT NULL;
ALTER TABLE lais.document ADD CONSTRAINT document_no_uq UNIQUE (document_no);
CREATE UNIQUE INDEX document_supersedes_uq ON lais.document (supersedes_id) WHERE supersedes_id IS NOT NULL;
UPDATE lais.document SET review_status = CASE verification_status WHEN 'verified' THEN 'accepted' WHEN 'rejected' THEN 'incomplete' ELSE 'not_reviewed' END;

-- Stored files are never replaced or removed: a new version is a new row.
CREATE FUNCTION lais.protect_document() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Documents are never deleted; upload a new version instead';
  END IF;
  IF (NEW.case_id, NEW.storage_key, NEW.sha256, NEW.mime_type, NEW.size_bytes, NEW.original_name, NEW.uploaded_by, NEW.uploaded_at,
      NEW.document_no, NEW.version_no, NEW.supersedes_id)
     IS DISTINCT FROM
     (OLD.case_id, OLD.storage_key, OLD.sha256, OLD.mime_type, OLD.size_bytes, OLD.original_name, OLD.uploaded_by, OLD.uploaded_at,
      OLD.document_no, OLD.version_no, OLD.supersedes_id) THEN
    RAISE EXCEPTION 'Document % cannot be altered; upload a new version instead', OLD.document_no;
  END IF;
  IF OLD.review_status = 'superseded' AND NEW.review_status <> 'superseded' THEN
    RAISE EXCEPTION 'Document % has been superseded by a newer version', OLD.document_no;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER document_protect BEFORE UPDATE OR DELETE ON lais.document
  FOR EACH ROW EXECUTE FUNCTION lais.protect_document();

CREATE TABLE lais.document_review_event (
  id           bigserial PRIMARY KEY,
  document_id  uuid NOT NULL REFERENCES lais.document (id),
  case_id      uuid NOT NULL REFERENCES lais.land_case (id),
  from_status  text,
  to_status    text NOT NULL,
  -- What the reviewer checked (readable, pages present, details match the application).
  checks       jsonb NOT NULL DEFAULT '{}',
  note         text,
  referred     boolean NOT NULL DEFAULT false,
  actor_id     uuid NOT NULL REFERENCES lais.app_user (id),
  at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX document_review_event_idx ON lais.document_review_event (document_id, id);
CREATE TRIGGER document_review_event_append_only BEFORE UPDATE OR DELETE ON lais.document_review_event
  FOR EACH ROW EXECUTE FUNCTION lais.forbid_history_change();
INSERT INTO lais.document_review_event (document_id, case_id, from_status, to_status, note, actor_id, at)
SELECT id, case_id, 'not_reviewed', review_status, coalesce(verification_note, 'Recorded before migration 013'), verified_by, verified_at
  FROM lais.document WHERE verified_by IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Additional information requests to applicants
-- ---------------------------------------------------------------------------
CREATE SEQUENCE lais.info_request_no_seq;
CREATE TABLE lais.info_request (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_no       text NOT NULL UNIQUE DEFAULT 'IR-' || lpad(nextval('lais.info_request_no_seq')::text, 6, '0'),
  case_id          uuid NOT NULL REFERENCES lais.land_case (id),
  applicant_id     uuid REFERENCES lais.applicant (id),
  county_id        smallint NOT NULL REFERENCES lais.county (id),
  category         text NOT NULL CHECK (category IN ('missing_document', 'missing_information', 'clarification', 'replacement_document', 'other')),
  items            text NOT NULL CHECK (length(trim(items)) BETWEEN 3 AND 1000),
  doc_categories   text[] NOT NULL DEFAULT '{}',
  explanation      text NOT NULL CHECK (length(trim(explanation)) >= 10),
  due_date         date,
  channel          text NOT NULL CHECK (channel IN ('in_person', 'phone', 'letter', 'email', 'sms')),
  -- No e-mail or SMS provider is configured: such requests are recorded but NOT sent.
  delivery_status  text NOT NULL CHECK (delivery_status IN ('not_sent_no_provider', 'awaiting_manual_delivery', 'delivered_manually')),
  delivered_note   text,
  internal_note    text,
  status           text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'response_received', 'partially_satisfied', 'satisfied', 'closed')),
  requested_by     uuid NOT NULL REFERENCES lais.app_user (id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  closed_at        timestamptz
);
CREATE INDEX info_request_case_idx ON lais.info_request (case_id, created_at DESC);
CREATE INDEX info_request_county_idx ON lais.info_request (county_id, status);
CREATE TRIGGER info_request_no_delete BEFORE DELETE ON lais.info_request
  FOR EACH ROW EXECUTE FUNCTION lais.forbid_history_change();

CREATE TABLE lais.info_request_event (
  id            bigserial PRIMARY KEY,
  request_id    uuid NOT NULL REFERENCES lais.info_request (id),
  action        text NOT NULL CHECK (action IN ('created', 'delivered', 'response_recorded', 'partially_satisfied', 'satisfied', 'reopened', 'closed')),
  from_status   text,
  to_status     text,
  note          text,
  response_channel text,
  document_ids  uuid[] NOT NULL DEFAULT '{}',
  actor_id      uuid NOT NULL REFERENCES lais.app_user (id),
  at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX info_request_event_idx ON lais.info_request_event (request_id, id);
CREATE TRIGGER info_request_event_append_only BEFORE UPDATE OR DELETE ON lais.info_request_event
  FOR EACH ROW EXECUTE FUNCTION lais.forbid_history_change();

-- ---------------------------------------------------------------------------
-- Completeness exceptions (granted by a supervisor, with a reason) and GIS handoffs
-- ---------------------------------------------------------------------------
CREATE TABLE lais.completeness_exception (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id       uuid NOT NULL REFERENCES lais.land_case (id),
  stage         text NOT NULL CHECK (stage IN ('gis_handoff', 'submission')),
  requirement_keys text[] NOT NULL CHECK (cardinality(requirement_keys) > 0),
  reason        text NOT NULL CHECK (length(trim(reason)) >= 20),
  granted_by    uuid NOT NULL REFERENCES lais.app_user (id),
  granted_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX completeness_exception_case_idx ON lais.completeness_exception (case_id, stage);
CREATE TRIGGER completeness_exception_append_only BEFORE UPDATE OR DELETE ON lais.completeness_exception
  FOR EACH ROW EXECUTE FUNCTION lais.forbid_history_change();

CREATE SEQUENCE lais.handoff_no_seq;
CREATE TABLE lais.application_handoff (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  handoff_no           text NOT NULL UNIQUE DEFAULT 'HO-' || lpad(nextval('lais.handoff_no_seq')::text, 6, '0'),
  case_id              uuid NOT NULL REFERENCES lais.land_case (id),
  task_id              uuid NOT NULL REFERENCES lais.task (id),
  processor_id         uuid NOT NULL REFERENCES lais.app_user (id),
  task_type            text NOT NULL,
  instructions         text NOT NULL CHECK (length(trim(instructions)) >= 10),
  declared_parcel_ref  text,
  document_ids         uuid[] NOT NULL DEFAULT '{}',
  priority             text NOT NULL,
  -- The checklist as it stood at handoff, and the exception relied on, if any.
  checklist            jsonb NOT NULL,
  exception_id         uuid REFERENCES lais.completeness_exception (id),
  created_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX application_handoff_case_idx ON lais.application_handoff (case_id, created_at DESC);
CREATE TRIGGER application_handoff_append_only BEFORE UPDATE OR DELETE ON lais.application_handoff
  FOR EACH ROW EXECUTE FUNCTION lais.forbid_history_change();

-- Administrative notes on an application. Append-only.
CREATE TABLE lais.application_note (
  id        bigserial PRIMARY KEY,
  case_id   uuid NOT NULL REFERENCES lais.land_case (id),
  note      text NOT NULL CHECK (length(trim(note)) BETWEEN 3 AND 4000),
  actor_id  uuid NOT NULL REFERENCES lais.app_user (id),
  at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX application_note_idx ON lais.application_note (case_id, id);
CREATE TRIGGER application_note_append_only BEFORE UPDATE OR DELETE ON lais.application_note
  FOR EACH ROW EXECUTE FUNCTION lais.forbid_history_change();

-- Notification category for application events.
ALTER TABLE lais.notification DROP CONSTRAINT notification_category_check;
ALTER TABLE lais.notification ADD CONSTRAINT notification_category_check
  CHECK (category IN ('account', 'security', 'workflow', 'gis', 'system', 'task', 'escalation', 'review', 'application'));

-- ---------------------------------------------------------------------------
-- Completeness, computed in one place (used by the checklist, the dashboards and the gates).
-- States: complete | missing | received (awaiting review) | unreadable | incomplete | clarification.
-- A requirement is "waived" when a supervisor's completeness exception lists it.
-- ---------------------------------------------------------------------------
CREATE FUNCTION lais.application_requirement_states(p_case uuid)
RETURNS TABLE (requirement_id uuid, req_key text, kind text, label text, stage text, mandatory boolean, applies boolean, state text, waived_for text[])
LANGUAGE sql STABLE AS $$
  WITH c AS (SELECT * FROM lais.land_case WHERE id = p_case),
  docs AS (
    SELECT d.doc_type, array_agg(d.review_status) AS statuses
      FROM lais.document d WHERE d.case_id = p_case AND d.review_status <> 'superseded' GROUP BY d.doc_type
  )
  SELECT r.id,
         r.kind || ':' || coalesce(r.field_key, r.doc_category),
         r.kind,
         CASE r.kind WHEN 'document' THEN dc.label ELSE CASE r.field_key
           WHEN 'applicant' THEN 'Applicant' WHEN 'purpose' THEN 'Purpose of the application' WHEN 'submission_date' THEN 'Submission date'
           WHEN 'receiving_office' THEN 'Receiving office' WHEN 'declared_parcel_ref' THEN 'Declared parcel reference'
           WHEN 'title_deed_ref' THEN 'Existing title or deed reference' WHEN 'location_description' THEN 'Location description'
           WHEN 'district' THEN 'District' WHEN 'locality' THEN 'Community or locality' WHEN 'declared_land_use' THEN 'Declared land use'
           WHEN 'declared_area' THEN 'Declared land size' WHEN 'survey_reference' THEN 'Survey reference' END END,
         r.stage, r.mandatory,
         CASE r.condition_field
           WHEN NULL THEN true
           WHEN 'declared_area_unit' THEN c.declared_area_unit IS NOT DISTINCT FROM r.condition_value
           WHEN 'receiving_office' THEN c.receiving_office IS NOT DISTINCT FROM r.condition_value
           WHEN 'title_deed_ref_present' THEN (c.title_deed_ref IS NOT NULL)::text = r.condition_value
           WHEN 'survey_reference_present' THEN (c.survey_reference IS NOT NULL)::text = r.condition_value
           ELSE true END,
         CASE r.kind
           WHEN 'field' THEN CASE WHEN (CASE r.field_key
               WHEN 'applicant' THEN c.applicant_id IS NOT NULL
               WHEN 'purpose' THEN nullif(btrim(c.purpose), '') IS NOT NULL
               WHEN 'submission_date' THEN c.submission_date IS NOT NULL
               WHEN 'receiving_office' THEN nullif(btrim(c.receiving_office), '') IS NOT NULL
               WHEN 'declared_parcel_ref' THEN nullif(btrim(c.declared_parcel_ref), '') IS NOT NULL OR c.parcel_id IS NOT NULL
               WHEN 'title_deed_ref' THEN nullif(btrim(c.title_deed_ref), '') IS NOT NULL
               WHEN 'location_description' THEN nullif(btrim(c.location_description), '') IS NOT NULL
               WHEN 'district' THEN nullif(btrim(c.district), '') IS NOT NULL
               WHEN 'locality' THEN nullif(btrim(c.locality), '') IS NOT NULL
               WHEN 'declared_land_use' THEN nullif(btrim(c.declared_land_use), '') IS NOT NULL
               WHEN 'declared_area' THEN c.declared_area IS NOT NULL
               WHEN 'survey_reference' THEN nullif(btrim(c.survey_reference), '') IS NOT NULL
               ELSE false END) THEN 'complete' ELSE 'missing' END
           ELSE CASE
             WHEN d.statuses IS NULL THEN 'missing'
             WHEN 'accepted' = ANY (d.statuses) THEN 'complete'
             WHEN 'unreadable' = ANY (d.statuses) THEN 'unreadable'
             WHEN 'incomplete' = ANY (d.statuses) THEN 'incomplete'
             WHEN 'inconsistent' = ANY (d.statuses) OR 'requires_clarification' = ANY (d.statuses) THEN 'clarification'
             ELSE 'received' END
         END,
         coalesce((SELECT array_agg(DISTINCT e.stage) FROM lais.completeness_exception e
                    WHERE e.case_id = p_case AND (r.kind || ':' || coalesce(r.field_key, r.doc_category)) = ANY (e.requirement_keys)), '{}')
    FROM c
    JOIN lais.application_requirement r ON r.category_code = c.category_code AND r.active
    LEFT JOIN lais.document_category dc ON dc.code = r.doc_category
    LEFT JOIN docs d ON d.doc_type = r.doc_category
$$;

-- The completeness status of an application registered through intake (NULL for other cases).
--   draft | awaiting_information | incomplete | ready_for_review | complete
CREATE FUNCTION lais.application_completeness(p_case uuid) RETURNS text LANGUAGE sql STABLE AS $$
  SELECT CASE
    WHEN c.applicant_id IS NULL THEN NULL
    WHEN c.intake_status = 'draft' THEN 'draft'
    WHEN EXISTS (SELECT 1 FROM lais.info_request i WHERE i.case_id = c.id AND i.status IN ('pending', 'response_received', 'partially_satisfied')) THEN 'awaiting_information'
    WHEN EXISTS (SELECT 1 FROM lais.application_requirement_states(c.id) s
                  WHERE s.applies AND s.mandatory AND cardinality(s.waived_for) = 0 AND s.state IN ('missing', 'unreadable', 'incomplete', 'clarification')) THEN 'incomplete'
    WHEN EXISTS (SELECT 1 FROM lais.application_requirement_states(c.id) s
                  WHERE s.applies AND s.mandatory AND cardinality(s.waived_for) = 0 AND s.state <> 'complete') THEN 'ready_for_review'
    ELSE 'complete' END
  FROM lais.land_case c WHERE c.id = p_case
$$;
