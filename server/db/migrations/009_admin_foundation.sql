-- Administration foundation: staff profiles and activation, county configuration for all 15 counties,
-- notifications, system settings, configurable document categories, backup log, and a spatial-conflict view.

-- ---------------------------------------------------------------------------
-- Staff accounts
-- ---------------------------------------------------------------------------
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT conname FROM pg_constraint
            WHERE conrelid = 'lais.app_user'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%status%'
  LOOP
    EXECUTE format('ALTER TABLE lais.app_user DROP CONSTRAINT %I', r.conname);
  END LOOP;
END $$;

ALTER TABLE lais.app_user
  ADD COLUMN email text CHECK (email IS NULL OR email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  ADD COLUMN staff_id text CHECK (staff_id IS NULL OR staff_id ~ '^[A-Za-z0-9-]{2,32}$'),
  ADD COLUMN department text,
  ADD COLUMN last_login_at timestamptz,
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now(),
  ALTER COLUMN password_hash DROP NOT NULL,
  -- 'invited': created by an administrator, waiting for the person to set their own password.
  ADD CONSTRAINT app_user_status_check CHECK (status IN ('invited', 'active', 'suspended', 'deactivated')),
  ADD CONSTRAINT app_user_password_check CHECK (status = 'invited' OR password_hash IS NOT NULL);
CREATE UNIQUE INDEX app_user_email_uq ON lais.app_user (lower(email)) WHERE email IS NOT NULL;
CREATE UNIQUE INDEX app_user_staff_id_uq ON lais.app_user (upper(staff_id)) WHERE staff_id IS NOT NULL;

-- One-time tokens for account activation and administrator-initiated password resets.
-- Only a hash is stored; the token itself is shown once to the administrator to deliver.
CREATE TABLE lais.account_token (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES lais.app_user (id),
  purpose     text NOT NULL CHECK (purpose IN ('activation', 'password_reset')),
  token_hash  bytea NOT NULL UNIQUE,
  created_by  uuid REFERENCES lais.app_user (id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  revoked_at  timestamptz
);
CREATE INDEX account_token_user_idx ON lais.account_token (user_id);

-- ---------------------------------------------------------------------------
-- Counties: all 15 can be represented; only configured ones carry a boundary.
-- ---------------------------------------------------------------------------
ALTER TABLE lais.county
  ALTER COLUMN geom DROP NOT NULL,
  ADD COLUMN boundary_status text NOT NULL DEFAULT 'unconfigured'
    CHECK (boundary_status IN ('unconfigured', 'synthetic', 'provisional', 'verified')),
  ADD COLUMN boundary_source text,
  ADD COLUMN boundary_verified_by uuid REFERENCES lais.app_user (id),
  ADD COLUMN boundary_verified_at timestamptz,
  -- Enabled counties accept new cases. Enabling needs a boundary to validate parcels against.
  ADD COLUMN enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();

UPDATE lais.county
   SET boundary_status = CASE WHEN is_synthetic THEN 'synthetic' ELSE 'provisional' END,
       boundary_source = CASE WHEN is_synthetic THEN 'Synthetic prototype rectangle (not an official boundary)' ELSE boundary_source END,
       enabled = true
 WHERE geom IS NOT NULL;

ALTER TABLE lais.county
  ADD CONSTRAINT county_boundary_geom_check CHECK ((geom IS NULL) = (boundary_status = 'unconfigured')),
  ADD CONSTRAINT county_enabled_needs_boundary CHECK (NOT enabled OR geom IS NOT NULL),
  ADD CONSTRAINT county_verified_needs_provenance
    CHECK (boundary_status <> 'verified' OR (boundary_source IS NOT NULL AND boundary_verified_by IS NOT NULL AND boundary_verified_at IS NOT NULL));

-- ---------------------------------------------------------------------------
-- Notifications (in-app only; no e-mail or SMS delivery in the prototype)
-- ---------------------------------------------------------------------------
CREATE TABLE lais.notification (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES lais.app_user (id),
  category    text NOT NULL CHECK (category IN ('account', 'security', 'workflow', 'gis', 'system')),
  title       text NOT NULL,
  body        text,
  link        text CHECK (link IS NULL OR link ~ '^/[A-Za-z0-9/_?=&.-]*$'),
  created_at  timestamptz NOT NULL DEFAULT now(),
  read_at     timestamptz
);
CREATE INDEX notification_user_unread_idx ON lais.notification (user_id, created_at DESC) WHERE read_at IS NULL;

-- ---------------------------------------------------------------------------
-- Non-legal system configuration (an allow-list of keys)
-- ---------------------------------------------------------------------------
CREATE TABLE lais.system_setting (
  key          text PRIMARY KEY,
  value        jsonb NOT NULL,
  description  text NOT NULL,
  updated_by   uuid REFERENCES lais.app_user (id),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
INSERT INTO lais.system_setting (key, value, description) VALUES
  ('portal.banner_message', '""', 'Message shown to all signed-in staff at the top of every page (empty for none)'),
  ('support.contact', '"Contact your county LAIS focal point."', 'How staff reach support; shown on the Help page'),
  ('notifications.in_app_enabled', 'true', 'Whether in-app notifications are created for staff');

-- ---------------------------------------------------------------------------
-- Document categories: configurable, with the categories the workflow rules depend on marked as system
-- ---------------------------------------------------------------------------
CREATE TABLE lais.document_category (
  code         text PRIMARY KEY CHECK (code ~ '^[a-z][a-z0-9_]{2,40}$'),
  label        text NOT NULL,
  description  text,
  active       boolean NOT NULL DEFAULT true,
  -- System categories are referenced by validation rules: they can be relabelled but not deactivated.
  system       boolean NOT NULL DEFAULT false,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  updated_by   uuid REFERENCES lais.app_user (id),
  CHECK (NOT system OR active)
);
INSERT INTO lais.document_category (code, label, description, system) VALUES
  ('deed', 'Deed', 'Deed or title instrument', true),
  ('survey_plan', 'Survey plan', 'Survey plan or survey report', true),
  ('customary_certificate', 'Customary land certificate', 'Evidence of customary land rights', true),
  ('id_document', 'Identity document', 'Identity document; always highly sensitive', true),
  ('power_of_attorney', 'Power of attorney', 'Authority to act for another party', true),
  ('other', 'Other', 'Other legally recognised evidence', true);

DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT conname FROM pg_constraint
            WHERE conrelid = 'lais.document'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%doc_type%'
  LOOP
    EXECUTE format('ALTER TABLE lais.document DROP CONSTRAINT %I', r.conname);
  END LOOP;
END $$;
ALTER TABLE lais.document ADD CONSTRAINT document_category_fk FOREIGN KEY (doc_type) REFERENCES lais.document_category (code);

-- ---------------------------------------------------------------------------
-- Backups initiated through the application (pg_dump)
-- ---------------------------------------------------------------------------
CREATE TABLE lais.backup_run (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  started_at    timestamptz NOT NULL DEFAULT now(),
  finished_at   timestamptz,
  status        text NOT NULL CHECK (status IN ('running', 'succeeded', 'failed')),
  initiated_by  uuid REFERENCES lais.app_user (id),
  method        text NOT NULL,
  file_name     text,
  size_bytes    bigint,
  sha256        text,
  error         text
);

-- ---------------------------------------------------------------------------
-- Spatial conflicts, derived from validation findings (one row per conflict finding of each case's
-- latest validation run). Review status: open (needs acknowledgement), acknowledged (a registrar
-- recorded an investigation note) or closed (the case is no longer open).
-- ---------------------------------------------------------------------------
CREATE VIEW lais.spatial_conflict AS
WITH latest AS (
  SELECT DISTINCT ON (case_id) id, case_id, run_at FROM staging.validation_run ORDER BY case_id, run_at DESC
)
SELECT f.id, f.code, f.severity, f.message, f.related_parcel_id, f.related_case_id, f.feature_index,
       c.id AS case_id, c.case_no, c.case_type, c.county_id, c.status AS case_status, l.run_at AS detected_at,
       f.acknowledged_at,
       CASE WHEN c.status NOT IN ('draft', 'validating', 'under_review', 'returned', 'approved') THEN 'closed'
            WHEN f.acknowledged_at IS NOT NULL THEN 'acknowledged'
            ELSE 'open' END AS review_status
  FROM latest l
  JOIN staging.finding f ON f.run_id = l.id
  JOIN lais.land_case c ON c.id = l.case_id
 WHERE f.code IN ('OVERLAP_PUBLISHED_PARCEL', 'DUPLICATE_GEOMETRY_SUSPECTED', 'CONFLICTING_OPEN_SUBMISSION',
                  'MIGRATION_INTERNAL_OVERLAP', 'NEW_PARCELS_OVERLAP', 'CROSSES_COUNTY_BOUNDARY',
                  'OUTSIDE_CASE_COUNTY', 'SIGNIFICANT_BOUNDARY_CHANGE', 'COVERAGE_GAP', 'COVERAGE_EXCEEDS_SOURCE');
