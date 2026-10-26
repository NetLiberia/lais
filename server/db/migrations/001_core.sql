-- LAIS core schema. Conceptually follows ISO 19152 (LADM): parties, rights (RRR),
-- spatial units (parcels) and administrative sources (documents, cases).
-- Record types, statuses and land categories are placeholders pending approval
-- by the Liberia Land Authority and legal advisers.

CREATE EXTENSION IF NOT EXISTS postgis;

CREATE SCHEMA IF NOT EXISTS lais;     -- administrative records, published and historical parcel data
CREATE SCHEMA IF NOT EXISTS staging;  -- imported, unpublished spatial submissions and validation results
CREATE SCHEMA IF NOT EXISTS audit;    -- append-only, hash-chained audit trail

-- ---------------------------------------------------------------------------
-- Administrative areas
-- ---------------------------------------------------------------------------
CREATE TABLE lais.county (
  id            smallint PRIMARY KEY,
  code          text NOT NULL UNIQUE CHECK (code ~ '^[A-Z]{2}$'),
  name          text NOT NULL,
  geom          geometry(MultiPolygon, 4326) NOT NULL CHECK (ST_IsValid(geom)),
  is_synthetic  boolean NOT NULL DEFAULT true
);
CREATE INDEX county_geom_gix ON lais.county USING gist (geom);

-- ---------------------------------------------------------------------------
-- Users, roles and sessions
-- ---------------------------------------------------------------------------
CREATE TABLE lais.app_user (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  username                text NOT NULL UNIQUE CHECK (username ~ '^[a-z0-9._-]{3,64}$'),
  display_name            text NOT NULL,
  password_hash           text NOT NULL,
  status                  text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'deactivated')),
  mfa_secret_enc          text,
  mfa_pending_secret_enc  text,
  failed_logins           integer NOT NULL DEFAULT 0,
  locked_until            timestamptz,
  password_changed_at     timestamptz NOT NULL DEFAULT now(),
  created_at              timestamptz NOT NULL DEFAULT now(),
  created_by              uuid REFERENCES lais.app_user (id)
);

CREATE TABLE lais.role_assignment (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid NOT NULL REFERENCES lais.app_user (id),
  role           text NOT NULL CHECK (role IN ('system_admin', 'gis_officer', 'processor', 'registrar', 'supervisor', 'auditor', 'landowner')),
  county_id      smallint REFERENCES lais.county (id),
  grant_reason   text NOT NULL,
  granted_by     uuid REFERENCES lais.app_user (id),
  granted_at     timestamptz NOT NULL DEFAULT now(),
  revoked_by     uuid REFERENCES lais.app_user (id),
  revoked_at     timestamptz,
  revoke_reason  text,
  -- Operational roles always act within an assigned county.
  CHECK (role NOT IN ('gis_officer', 'processor', 'registrar') OR county_id IS NOT NULL),
  CHECK (role NOT IN ('system_admin', 'auditor', 'landowner') OR county_id IS NULL),
  -- Nobody grants roles to themselves.
  CHECK (granted_by IS NULL OR granted_by <> user_id),
  CHECK ((revoked_at IS NULL) = (revoked_by IS NULL))
);
CREATE UNIQUE INDEX role_assignment_active_uq
  ON lais.role_assignment (user_id, role, coalesce(county_id, 0)) WHERE revoked_at IS NULL;

CREATE TABLE lais.session (
  token_hash           bytea PRIMARY KEY,
  user_id              uuid NOT NULL REFERENCES lais.app_user (id),
  state                text NOT NULL CHECK (state IN ('active', 'mfa_pending', 'enrollment_required')),
  csrf_token           text NOT NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  expires_at           timestamptz NOT NULL,
  absolute_expires_at  timestamptz NOT NULL,
  revoked_at           timestamptz,
  ip                   text,
  user_agent           text
);
CREATE INDEX session_user_idx ON lais.session (user_id);

-- ---------------------------------------------------------------------------
-- Parties (LADM LA_Party): people, organisations, communities, government bodies
-- ---------------------------------------------------------------------------
CREATE TABLE lais.party (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  party_type       text NOT NULL CHECK (party_type IN ('person', 'organization', 'community', 'government')),
  name             text NOT NULL,
  national_id_ref  text,  -- highly sensitive: never returned by search or public endpoints
  contact          text,  -- restricted
  identity_status  text NOT NULL DEFAULT 'unverified' CHECK (identity_status IN ('unverified', 'verified')),
  verified_by      uuid REFERENCES lais.app_user (id),
  verified_at      timestamptz,
  verification_note text,
  created_by       uuid REFERENCES lais.app_user (id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  is_synthetic     boolean NOT NULL DEFAULT false,
  CHECK (identity_status = 'unverified' OR (verified_by IS NOT NULL AND verified_at IS NOT NULL)),
  CHECK (verified_by IS NULL OR created_by IS NULL OR verified_by <> created_by)
);
CREATE INDEX party_name_idx ON lais.party (lower(name));

-- A landowner account is linked to a party only after staff verification.
-- The link is not proof of any interest in land.
CREATE TABLE lais.user_party_link (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES lais.app_user (id),
  party_id    uuid NOT NULL REFERENCES lais.party (id),
  linked_by   uuid NOT NULL REFERENCES lais.app_user (id),
  linked_at   timestamptz NOT NULL DEFAULT now(),
  revoked_at  timestamptz,
  CHECK (linked_by <> user_id)
);
CREATE UNIQUE INDEX user_party_link_active_uq ON lais.user_party_link (user_id, party_id) WHERE revoked_at IS NULL;

-- ---------------------------------------------------------------------------
-- Parcels (LADM LA_SpatialUnit) with immutable versions
-- ---------------------------------------------------------------------------
-- Provisional identifiers only. The official Liberian UPI format must come from the competent authority.
CREATE SEQUENCE lais.provisional_upi_seq START 1000;

CREATE TABLE lais.parcel (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  upi                 text NOT NULL UNIQUE,
  county_id           smallint NOT NULL REFERENCES lais.county (id),
  status              text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disputed', 'retired')),
  current_version_id  uuid,
  created_at          timestamptz NOT NULL DEFAULT now(),
  is_synthetic        boolean NOT NULL DEFAULT false
);

CREATE TABLE lais.parcel_version (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  parcel_id            uuid NOT NULL REFERENCES lais.parcel (id),
  version_no           integer NOT NULL CHECK (version_no > 0),
  geom                 geometry(MultiPolygon, 4326) NOT NULL CHECK (ST_IsValid(geom) AND NOT ST_IsEmpty(geom)),
  -- Calculated area is not the legal or surveyed area; both are kept with provenance.
  area_m2_calculated   numeric(14, 2) NOT NULL,
  area_method          text NOT NULL,
  area_m2_surveyed     numeric(14, 2),
  land_category        text NOT NULL CHECK (land_category IN ('public', 'government', 'customary', 'private')),
  land_use             text,
  source_reference     text NOT NULL,
  valid_from           timestamptz NOT NULL DEFAULT now(),
  valid_to             timestamptz,
  published_by_case    uuid,
  UNIQUE (parcel_id, version_no),
  CHECK (valid_to IS NULL OR valid_to >= valid_from)
);
CREATE UNIQUE INDEX parcel_version_current_uq ON lais.parcel_version (parcel_id) WHERE valid_to IS NULL;
CREATE INDEX parcel_version_current_gix ON lais.parcel_version USING gist (geom) WHERE valid_to IS NULL;

ALTER TABLE lais.parcel
  ADD CONSTRAINT parcel_current_version_fk FOREIGN KEY (current_version_id)
  REFERENCES lais.parcel_version (id) DEFERRABLE INITIALLY DEFERRED;

-- ---------------------------------------------------------------------------
-- Cases (transactions) and workflow
-- ---------------------------------------------------------------------------
CREATE SEQUENCE lais.case_no_seq;

CREATE TABLE lais.land_case (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_no           text NOT NULL UNIQUE
                    DEFAULT ('CASE-' || to_char(now(), 'YYYY') || '-' || lpad(nextval('lais.case_no_seq')::text, 6, '0')),
  case_type         text NOT NULL CHECK (case_type IN ('first_registration', 'transfer')),
  county_id         smallint NOT NULL REFERENCES lais.county (id),
  parcel_id         uuid REFERENCES lais.parcel (id),
  status            text NOT NULL DEFAULT 'draft'
                    CHECK (status IN ('draft', 'validating', 'under_review', 'returned', 'approved', 'rejected', 'published', 'withdrawn')),
  proposed_upi      text,
  land_category     text CHECK (land_category IN ('public', 'government', 'customary', 'private')),
  land_use          text,
  source_reference  text,
  created_by        uuid NOT NULL REFERENCES lais.app_user (id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CHECK (case_type <> 'transfer' OR parcel_id IS NOT NULL),
  CHECK (status <> 'published' OR parcel_id IS NOT NULL)
);
CREATE INDEX land_case_county_status_idx ON lais.land_case (county_id, status);

ALTER TABLE lais.parcel_version
  ADD CONSTRAINT parcel_version_case_fk FOREIGN KEY (published_by_case) REFERENCES lais.land_case (id);

CREATE TABLE lais.case_event (
  id           bigserial PRIMARY KEY,
  case_id      uuid NOT NULL REFERENCES lais.land_case (id),
  actor_id     uuid REFERENCES lais.app_user (id),
  action       text NOT NULL,
  from_status  text,
  to_status    text,
  note         text,
  at           timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX case_event_case_idx ON lais.case_event (case_id, id);

CREATE TABLE lais.case_right_proposal (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id     uuid NOT NULL REFERENCES lais.land_case (id),
  party_id    uuid NOT NULL REFERENCES lais.party (id),
  rrr_type    text NOT NULL CHECK (rrr_type IN ('ownership', 'co_ownership', 'customary_tenure', 'lease', 'mortgage', 'easement')),
  share_num   integer,
  share_den   integer,
  created_by  uuid NOT NULL REFERENCES lais.app_user (id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  CHECK ((share_num IS NULL) = (share_den IS NULL)),
  CHECK (share_den IS NULL OR (share_den > 0 AND share_num > 0 AND share_num <= share_den))
);

CREATE TABLE lais.document (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id              uuid NOT NULL REFERENCES lais.land_case (id),
  doc_type             text NOT NULL CHECK (doc_type IN ('deed', 'survey_plan', 'customary_certificate', 'id_document', 'power_of_attorney', 'other')),
  reference_no         text,
  issuer               text,
  issued_on            date,
  classification       text NOT NULL CHECK (classification IN ('public', 'restricted', 'highly_sensitive')),
  storage_key          text NOT NULL UNIQUE CHECK (storage_key ~ '^[a-f0-9]{32}$'),
  sha256               text NOT NULL,
  mime_type            text NOT NULL,
  size_bytes           integer NOT NULL,
  original_name        text NOT NULL,
  uploaded_by          uuid NOT NULL REFERENCES lais.app_user (id),
  uploaded_at          timestamptz NOT NULL DEFAULT now(),
  verification_status  text NOT NULL DEFAULT 'pending' CHECK (verification_status IN ('pending', 'verified', 'rejected')),
  verified_by          uuid REFERENCES lais.app_user (id),
  verified_at          timestamptz,
  verification_note    text,
  -- Separation of duties: the uploader cannot verify their own document.
  CHECK (verified_by IS NULL OR verified_by <> uploaded_by),
  CHECK (verification_status = 'pending' OR (verified_by IS NOT NULL AND verified_at IS NOT NULL))
);
CREATE INDEX document_case_idx ON lais.document (case_id);

CREATE TABLE lais.case_decision (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id            uuid NOT NULL REFERENCES lais.land_case (id),
  decided_by         uuid NOT NULL REFERENCES lais.app_user (id),
  decision           text NOT NULL CHECK (decision IN ('approved', 'rejected', 'returned')),
  reason             text NOT NULL CHECK (length(btrim(reason)) >= 5),
  authority_basis    text,
  validation_run_id  uuid,
  -- Hash of exactly what the decision-maker reviewed (case data, geometry, rights, documents).
  snapshot_hash      text NOT NULL,
  decided_at         timestamptz NOT NULL DEFAULT clock_timestamp(),
  superseded_at      timestamptz,
  CHECK (decision <> 'approved' OR authority_basis IS NOT NULL)
);
CREATE INDEX case_decision_case_idx ON lais.case_decision (case_id, decided_at);

-- ---------------------------------------------------------------------------
-- Rights, restrictions and responsibilities (LADM LA_RRR)
-- ---------------------------------------------------------------------------
CREATE TABLE lais.rrr (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  parcel_id        uuid NOT NULL REFERENCES lais.parcel (id),
  party_id         uuid NOT NULL REFERENCES lais.party (id),
  rrr_type         text NOT NULL CHECK (rrr_type IN ('ownership', 'co_ownership', 'customary_tenure', 'lease', 'mortgage', 'easement')),
  share_num        integer,
  share_den        integer,
  -- claimed / documented / reviewed / registered are distinct; only 'registered' results from an approved, published case.
  interest_status  text NOT NULL CHECK (interest_status IN ('claimed', 'documented', 'reviewed', 'registered')),
  valid_from       timestamptz NOT NULL DEFAULT now(),
  valid_to         timestamptz,
  created_by_case  uuid REFERENCES lais.land_case (id),
  ended_by_case    uuid REFERENCES lais.land_case (id),
  CHECK ((share_num IS NULL) = (share_den IS NULL)),
  CHECK (valid_to IS NULL OR valid_to >= valid_from)
);
CREATE INDEX rrr_parcel_current_idx ON lais.rrr (parcel_id) WHERE valid_to IS NULL;
CREATE INDEX rrr_party_idx ON lais.rrr (party_id);

CREATE TABLE lais.parcel_dispute (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  parcel_id    uuid NOT NULL REFERENCES lais.parcel (id),
  opened_by    uuid NOT NULL REFERENCES lais.app_user (id),
  opened_at    timestamptz NOT NULL DEFAULT now(),
  reason       text NOT NULL,
  referral     text,
  closed_by    uuid REFERENCES lais.app_user (id),
  closed_at    timestamptz,
  resolution   text,
  CHECK ((closed_at IS NULL) = (closed_by IS NULL))
);

-- ---------------------------------------------------------------------------
-- Database-level guards (defence in depth behind the API checks)
-- ---------------------------------------------------------------------------

-- Case status may only move along the approved workflow, so publication cannot
-- happen by editing the status column. Keep in sync with src/authz/workflow.ts.
CREATE FUNCTION lais.enforce_case_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'draft' THEN
      RAISE EXCEPTION 'New cases must start in draft';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.status = OLD.status THEN
    IF OLD.status IN ('published', 'rejected', 'withdrawn') AND NEW IS DISTINCT FROM OLD THEN
      RAISE EXCEPTION 'Closed case % cannot be modified', OLD.case_no;
    END IF;
    IF OLD.status NOT IN ('draft', 'returned', 'validating')
       AND (NEW.proposed_upi, NEW.land_category, NEW.land_use, NEW.source_reference, NEW.parcel_id, NEW.county_id)
           IS DISTINCT FROM (OLD.proposed_upi, OLD.land_category, OLD.land_use, OLD.source_reference, OLD.parcel_id, OLD.county_id) THEN
      RAISE EXCEPTION 'Case % cannot be edited while %', OLD.case_no, OLD.status;
    END IF;
    NEW.updated_at := now();
    RETURN NEW;
  END IF;

  IF (OLD.status, NEW.status) NOT IN (
       ('draft', 'validating'), ('draft', 'withdrawn'),
       ('validating', 'under_review'), ('validating', 'returned'),
       ('under_review', 'approved'), ('under_review', 'rejected'), ('under_review', 'returned'),
       ('returned', 'validating'), ('returned', 'withdrawn'),
       ('approved', 'published'), ('approved', 'under_review')
     ) THEN
    RAISE EXCEPTION 'Illegal case status transition % -> %', OLD.status, NEW.status;
  END IF;

  IF NEW.status IN ('approved', 'published') AND NOT EXISTS (
       SELECT 1 FROM lais.case_decision d
        WHERE d.case_id = NEW.id AND d.decision = 'approved' AND d.superseded_at IS NULL) THEN
    RAISE EXCEPTION 'Case % has no current approval decision', OLD.case_no;
  END IF;

  NEW.updated_at := now();
  RETURN NEW;
END $$;

CREATE TRIGGER land_case_transition
  BEFORE INSERT OR UPDATE ON lais.land_case
  FOR EACH ROW EXECUTE FUNCTION lais.enforce_case_transition();

-- Published parcel versions are history: never deleted, never rewritten.
-- The only permitted change is closing the current version (setting valid_to).
CREATE FUNCTION lais.protect_parcel_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Parcel versions cannot be deleted';
  END IF;
  IF OLD.valid_to IS NOT NULL OR NEW.valid_to IS NULL
     OR ST_AsEWKB(NEW.geom) <> ST_AsEWKB(OLD.geom)
     OR (NEW.id, NEW.parcel_id, NEW.version_no, NEW.area_m2_calculated, NEW.area_method, NEW.area_m2_surveyed,
         NEW.land_category, NEW.land_use, NEW.source_reference, NEW.valid_from, NEW.published_by_case)
        IS DISTINCT FROM
        (OLD.id, OLD.parcel_id, OLD.version_no, OLD.area_m2_calculated, OLD.area_method, OLD.area_m2_surveyed,
         OLD.land_category, OLD.land_use, OLD.source_reference, OLD.valid_from, OLD.published_by_case) THEN
    RAISE EXCEPTION 'Parcel versions are immutable; only closing the current version is allowed';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER parcel_version_protect
  BEFORE UPDATE OR DELETE ON lais.parcel_version
  FOR EACH ROW EXECUTE FUNCTION lais.protect_parcel_version();

-- Rights history is kept: a right can be ended (valid_to + ended_by_case) but not rewritten or deleted.
CREATE FUNCTION lais.protect_rrr() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Rights records cannot be deleted';
  END IF;
  IF OLD.valid_to IS NOT NULL OR NEW.valid_to IS NULL OR NEW.ended_by_case IS NULL
     OR (NEW.id, NEW.parcel_id, NEW.party_id, NEW.rrr_type, NEW.share_num, NEW.share_den,
         NEW.interest_status, NEW.valid_from, NEW.created_by_case)
        IS DISTINCT FROM
        (OLD.id, OLD.parcel_id, OLD.party_id, OLD.rrr_type, OLD.share_num, OLD.share_den,
         OLD.interest_status, OLD.valid_from, OLD.created_by_case) THEN
    RAISE EXCEPTION 'Rights are immutable; only ending a current right through a case is allowed';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER rrr_protect
  BEFORE UPDATE OR DELETE ON lais.rrr
  FOR EACH ROW EXECUTE FUNCTION lais.protect_rrr();
