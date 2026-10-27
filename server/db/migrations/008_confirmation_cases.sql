-- Confirmation cases: register the holders of a parcel whose interests are only 'documented'
-- (for example after legacy migration), once identities and evidence have been checked.
-- The documented interests are ended, not deleted, so the legacy record stays in the history.

DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT conname FROM pg_constraint
            WHERE conrelid = 'lais.land_case'::regclass AND contype = 'c'
              AND conname IN ('land_case_type_check', 'land_case_parcel_required_check')
  LOOP
    EXECUTE format('ALTER TABLE lais.land_case DROP CONSTRAINT %I', r.conname);
  END LOOP;
END $$;

ALTER TABLE lais.land_case
  ADD CONSTRAINT land_case_type_check
    CHECK (case_type IN ('first_registration', 'transfer', 'subdivision', 'consolidation', 'correction', 'migration', 'confirmation')),
  ADD CONSTRAINT land_case_parcel_required_check
    CHECK (case_type NOT IN ('transfer', 'correction', 'confirmation') OR parcel_id IS NOT NULL);
