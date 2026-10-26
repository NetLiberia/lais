-- Correction cases: fix errors in a published parcel's boundary or attributes by publishing a new
-- version. The erroneous version stays in the history; rights are never changed by a correction.

DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT conname FROM pg_constraint
            WHERE conrelid = 'lais.land_case'::regclass AND contype = 'c'
              AND conname IN ('land_case_type_check', 'land_case_transfer_parcel_check')
  LOOP
    EXECUTE format('ALTER TABLE lais.land_case DROP CONSTRAINT %I', r.conname);
  END LOOP;
END $$;

ALTER TABLE lais.land_case
  ADD COLUMN correction_reason text,
  -- Surveyed (legally recorded) area proposed by a correction; distinct from the calculated area.
  ADD COLUMN area_m2_surveyed numeric(14, 2) CHECK (area_m2_surveyed IS NULL OR area_m2_surveyed > 0),
  ADD CONSTRAINT land_case_type_check
    CHECK (case_type IN ('first_registration', 'transfer', 'subdivision', 'consolidation', 'correction')),
  ADD CONSTRAINT land_case_parcel_required_check
    CHECK (case_type NOT IN ('transfer', 'correction') OR parcel_id IS NOT NULL);

-- Correction fields are case data like any other: frozen once the case leaves draft/returned.
CREATE OR REPLACE FUNCTION lais.enforce_case_transition() RETURNS trigger LANGUAGE plpgsql AS $$
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
       AND (NEW.proposed_upi, NEW.land_category, NEW.land_use, NEW.source_reference, NEW.parcel_id, NEW.county_id,
            NEW.correction_reason, NEW.area_m2_surveyed)
           IS DISTINCT FROM
           (OLD.proposed_upi, OLD.land_category, OLD.land_use, OLD.source_reference, OLD.parcel_id, OLD.county_id,
            OLD.correction_reason, OLD.area_m2_surveyed) THEN
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
