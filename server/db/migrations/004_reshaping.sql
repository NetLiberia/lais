-- Subdivision (one parcel into several) and consolidation (several parcels into one).
-- These change geometry and identifiers, so they are separate case types from transfers.

-- Replace the case-type and publication checks on lais.land_case (they were created unnamed).
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT conname FROM pg_constraint
            WHERE conrelid = 'lais.land_case'::regclass AND contype = 'c'
              AND (pg_get_constraintdef(oid) LIKE '%case_type%' OR pg_get_constraintdef(oid) LIKE '%published%')
  LOOP
    EXECUTE format('ALTER TABLE lais.land_case DROP CONSTRAINT %I', r.conname);
  END LOOP;
END $$;

ALTER TABLE lais.land_case
  ADD CONSTRAINT land_case_type_check
    CHECK (case_type IN ('first_registration', 'transfer', 'subdivision', 'consolidation')),
  ADD CONSTRAINT land_case_transfer_parcel_check
    CHECK (case_type <> 'transfer' OR parcel_id IS NOT NULL),
  -- Registration and transfer publish to exactly one parcel; reshaping cases record their results in parcel_lineage.
  ADD CONSTRAINT land_case_published_parcel_check
    CHECK (status <> 'published' OR case_type IN ('subdivision', 'consolidation') OR parcel_id IS NOT NULL);

-- The published parcels a reshaping case consumes.
CREATE TABLE lais.case_source_parcel (
  case_id    uuid NOT NULL REFERENCES lais.land_case (id),
  parcel_id  uuid NOT NULL REFERENCES lais.parcel (id),
  PRIMARY KEY (case_id, parcel_id)
);
CREATE INDEX case_source_parcel_parcel_idx ON lais.case_source_parcel (parcel_id);

-- Which staged feature (new parcel) a proposed right applies to. NULL for single-parcel cases.
ALTER TABLE lais.case_right_proposal
  ADD COLUMN feature_index integer CHECK (feature_index IS NULL OR feature_index >= 0);

-- Parent/child history across subdivisions and consolidations.
CREATE TABLE lais.parcel_lineage (
  parent_parcel_id  uuid NOT NULL REFERENCES lais.parcel (id),
  child_parcel_id   uuid NOT NULL REFERENCES lais.parcel (id),
  case_id           uuid NOT NULL REFERENCES lais.land_case (id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (parent_parcel_id, child_parcel_id),
  CHECK (parent_parcel_id <> child_parcel_id)
);
CREATE INDEX parcel_lineage_child_idx ON lais.parcel_lineage (child_parcel_id);
