-- Staging area for imported spatial submissions. Nothing here is published data.

CREATE TABLE staging.batch (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id          uuid NOT NULL REFERENCES lais.land_case (id),
  uploaded_by      uuid NOT NULL REFERENCES lais.app_user (id),
  source_filename  text NOT NULL,
  file_sha256      text NOT NULL,
  declared_srid    integer NOT NULL,
  feature_count    integer NOT NULL,
  status           text NOT NULL CHECK (status IN ('active', 'superseded', 'published')),
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX batch_active_uq ON staging.batch (case_id) WHERE status = 'active';

CREATE TABLE staging.feature (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id            uuid NOT NULL REFERENCES staging.batch (id),
  feature_index       integer NOT NULL,
  -- Exactly as received, in the declared CRS. Never repaired.
  geom_input          geometry NOT NULL,
  -- Transformed to EPSG:4326 only when the input is structurally valid.
  geom                geometry(MultiPolygon, 4326),
  structural_ok       boolean NOT NULL,
  structural_message  text,
  properties          jsonb NOT NULL DEFAULT '{}'::jsonb,
  CHECK (structural_ok = (geom IS NOT NULL))
);
CREATE INDEX feature_geom_gix ON staging.feature USING gist (geom);

CREATE TABLE staging.validation_run (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id        uuid NOT NULL REFERENCES lais.land_case (id),
  batch_id       uuid REFERENCES staging.batch (id),
  run_by         uuid REFERENCES lais.app_user (id),
  run_at         timestamptz NOT NULL DEFAULT clock_timestamp(),
  purpose        text NOT NULL CHECK (purpose IN ('preview', 'submission', 'publication')),
  error_count    integer NOT NULL,
  warning_count  integer NOT NULL
);
CREATE INDEX validation_run_case_idx ON staging.validation_run (case_id, run_at DESC);

CREATE TABLE staging.finding (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id                uuid NOT NULL REFERENCES staging.validation_run (id),
  code                  text NOT NULL,
  severity              text NOT NULL CHECK (severity IN ('error', 'warning')),
  message               text NOT NULL,
  related_parcel_id     uuid REFERENCES lais.parcel (id),
  related_case_id       uuid REFERENCES lais.land_case (id),
  detail                jsonb NOT NULL DEFAULT '{}'::jsonb,
  acknowledged_by       uuid REFERENCES lais.app_user (id),
  acknowledged_at       timestamptz,
  acknowledgement_note  text,
  -- Errors must be fixed, not acknowledged away.
  CHECK (acknowledged_by IS NULL OR severity = 'warning'),
  CHECK ((acknowledged_by IS NULL) = (acknowledged_at IS NULL))
);
CREATE INDEX finding_run_idx ON staging.finding (run_id);
