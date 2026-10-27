-- Bulk migration of legacy land records through the normal staging, validation and approval workflow.
-- Holders named in a legacy register are recorded as 'documented' interests with unverified parties:
-- a name in an old record is not a legally confirmed interest.

DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT conname FROM pg_constraint
            WHERE conrelid = 'lais.land_case'::regclass AND contype = 'c'
              AND conname IN ('land_case_type_check', 'land_case_published_parcel_check')
  LOOP
    EXECUTE format('ALTER TABLE lais.land_case DROP CONSTRAINT %I', r.conname);
  END LOOP;
END $$;

ALTER TABLE lais.land_case
  ADD CONSTRAINT land_case_type_check
    CHECK (case_type IN ('first_registration', 'transfer', 'subdivision', 'consolidation', 'correction', 'migration')),
  -- Registration, transfer and correction publish to one parcel; reshaping and migration create several.
  ADD CONSTRAINT land_case_published_parcel_check
    CHECK (status <> 'published' OR case_type IN ('subdivision', 'consolidation', 'migration') OR parcel_id IS NOT NULL);

-- The identifier a parcel had in the legacy register, unique within a county, so a migration can be
-- re-run safely and every migrated parcel traced back to its source record.
ALTER TABLE lais.parcel ADD COLUMN legacy_ref text;
CREATE UNIQUE INDEX parcel_legacy_ref_uq ON lais.parcel (county_id, legacy_ref) WHERE legacy_ref IS NOT NULL;

-- Where a party record came from. Migrated parties are names copied from a legacy record.
ALTER TABLE lais.party ADD COLUMN origin text NOT NULL DEFAULT 'entered' CHECK (origin IN ('entered', 'migration'));

-- Quarantine: a GIS officer can exclude a problem feature from a batch, with a reason, instead of
-- rejecting the whole batch. Excluded features are reported but never published.
ALTER TABLE staging.feature
  ADD COLUMN excluded boolean NOT NULL DEFAULT false,
  ADD COLUMN exclusion_reason text,
  ADD COLUMN published_parcel_id uuid REFERENCES lais.parcel (id),
  ADD CONSTRAINT feature_exclusion_reason_check CHECK (NOT excluded OR length(btrim(coalesce(exclusion_reason, ''))) >= 5);

-- Which feature of a multi-feature batch a finding is about.
ALTER TABLE staging.finding ADD COLUMN feature_index integer;
