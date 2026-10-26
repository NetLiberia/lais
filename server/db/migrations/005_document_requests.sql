-- Landowner requests for copies of documents, released only after preparation by a processor
-- and a recorded decision by a registrar. Release is time-limited and every download is audited.
-- What may be released, to whom and for how long are placeholders pending the approved disclosure policy.

CREATE SEQUENCE lais.document_request_no_seq;

CREATE TABLE lais.document_request (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_no          text NOT NULL UNIQUE
                      DEFAULT ('DR-' || to_char(now(), 'YYYY') || '-' || lpad(nextval('lais.document_request_no_seq')::text, 6, '0')),
  requested_by        uuid NOT NULL REFERENCES lais.app_user (id),
  -- The linked party whose registered interest made the requester eligible, at the time of the request.
  party_id            uuid NOT NULL REFERENCES lais.party (id),
  parcel_id           uuid NOT NULL REFERENCES lais.parcel (id),
  county_id           smallint NOT NULL REFERENCES lais.county (id),
  document_types      text[] NOT NULL CHECK (
                        cardinality(document_types) >= 1
                        AND document_types <@ ARRAY['deed', 'survey_plan', 'customary_certificate', 'power_of_attorney', 'other']::text[]),
  purpose             text NOT NULL CHECK (length(btrim(purpose)) >= 10),
  status              text NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted', 'prepared', 'approved', 'refused', 'withdrawn')),
  prepared_by         uuid REFERENCES lais.app_user (id),
  prepared_at         timestamptz,
  preparation_note    text,
  decided_by          uuid REFERENCES lais.app_user (id),
  decided_at          timestamptz,
  decision_reason     text,
  release_expires_at  timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  -- Separation of duties: the officer who prepares a release does not approve it.
  CHECK (decided_by IS NULL OR prepared_by IS NULL OR decided_by <> prepared_by),
  CHECK (status <> 'approved' OR (decided_by IS NOT NULL AND release_expires_at IS NOT NULL)),
  CHECK (status NOT IN ('approved', 'refused') OR length(btrim(coalesce(decision_reason, ''))) >= 5)
);
CREATE INDEX document_request_county_status_idx ON lais.document_request (county_id, status);
CREATE INDEX document_request_requester_idx ON lais.document_request (requested_by);

-- The documents proposed for release.
CREATE TABLE lais.document_request_item (
  request_id   uuid NOT NULL REFERENCES lais.document_request (id),
  document_id  uuid NOT NULL REFERENCES lais.document (id),
  PRIMARY KEY (request_id, document_id)
);

-- Requests move only along the approved path; once decided they are closed, except that a
-- release may be cut short (revoked) by bringing its expiry forward.
CREATE FUNCTION lais.enforce_document_request() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'submitted' THEN RAISE EXCEPTION 'New document requests must start as submitted'; END IF;
    RETURN NEW;
  END IF;
  IF OLD.status IN ('approved', 'refused', 'withdrawn') THEN
    IF OLD.status = 'approved'
       AND NEW.release_expires_at <= OLD.release_expires_at
       AND (NEW.id, NEW.status, NEW.requested_by, NEW.party_id, NEW.parcel_id, NEW.document_types, NEW.prepared_by, NEW.decided_by, NEW.decision_reason)
           IS NOT DISTINCT FROM
           (OLD.id, OLD.status, OLD.requested_by, OLD.party_id, OLD.parcel_id, OLD.document_types, OLD.prepared_by, OLD.decided_by, OLD.decision_reason) THEN
      NEW.updated_at := now();
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'Document request % is closed', OLD.request_no;
  END IF;
  IF NEW.status <> OLD.status AND (OLD.status, NEW.status) NOT IN (
       ('submitted', 'prepared'), ('submitted', 'withdrawn'),
       ('prepared', 'approved'), ('prepared', 'refused'), ('prepared', 'withdrawn')) THEN
    RAISE EXCEPTION 'Illegal document request transition % -> %', OLD.status, NEW.status;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;

CREATE TRIGGER document_request_transition
  BEFORE INSERT OR UPDATE ON lais.document_request
  FOR EACH ROW EXECUTE FUNCTION lais.enforce_document_request();

-- The release set is fixed once prepared, and can never include highly sensitive documents.
CREATE FUNCTION lais.protect_document_request_item() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  req_status text;
  doc_class text;
BEGIN
  SELECT status INTO req_status FROM lais.document_request
   WHERE id = CASE WHEN TG_OP = 'DELETE' THEN OLD.request_id ELSE NEW.request_id END;
  IF req_status <> 'submitted' THEN
    RAISE EXCEPTION 'The documents in a prepared or decided request cannot be changed';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  SELECT classification INTO doc_class FROM lais.document WHERE id = NEW.document_id;
  IF doc_class = 'highly_sensitive' THEN
    RAISE EXCEPTION 'Highly sensitive documents cannot be released through a document request';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER document_request_item_protect
  BEFORE INSERT OR UPDATE OR DELETE ON lais.document_request_item
  FOR EACH ROW EXECUTE FUNCTION lais.protect_document_request_item();
