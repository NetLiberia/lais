-- Append-only, hash-chained audit trail.
-- Each event stores the hash of the previous event, so deleting or editing a row
-- (for example by someone who disabled the triggers) is detectable by audit.verify_chain().
-- A higher-assurance deployment should also ship events to a separately controlled log store.

CREATE TABLE audit.event (
  id              bigserial PRIMARY KEY,
  chain_seq       bigint NOT NULL UNIQUE,
  at              timestamptz NOT NULL DEFAULT clock_timestamp(),
  actor_id        uuid,
  actor_username  text,
  action          text NOT NULL,
  outcome         text NOT NULL CHECK (outcome IN ('success', 'denied', 'failure')),
  entity_type     text,
  entity_id       text,
  county_id       smallint,
  case_id         uuid,
  ip              text,
  detail          jsonb NOT NULL DEFAULT '{}'::jsonb,
  prev_hash       bytea,
  hash            bytea NOT NULL
);
CREATE INDEX event_at_idx ON audit.event (at DESC);
CREATE INDEX event_case_idx ON audit.event (case_id);
CREATE INDEX event_action_idx ON audit.event (action);

CREATE FUNCTION audit.event_hash(e audit.event) RETURNS bytea LANGUAGE sql STABLE AS $$
  SELECT sha256(
    coalesce(e.prev_hash, ''::bytea) ||
    convert_to(concat_ws('|',
      e.chain_seq::text,
      extract(epoch FROM e.at)::text,
      coalesce(e.actor_id::text, ''),
      coalesce(e.actor_username, ''),
      e.action,
      e.outcome,
      coalesce(e.entity_type, ''),
      coalesce(e.entity_id, ''),
      coalesce(e.county_id::text, ''),
      coalesce(e.case_id::text, ''),
      coalesce(e.ip, ''),
      e.detail::text), 'UTF8'))
$$;

-- The advisory lock serialises chain extension until the inserting transaction ends,
-- so chain_seq order always matches the order in which events link to each other.
CREATE FUNCTION audit.chain_event() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  last_seq bigint;
  last_hash bytea;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('audit.event.chain'));
  SELECT chain_seq, hash INTO last_seq, last_hash FROM audit.event ORDER BY chain_seq DESC LIMIT 1;
  NEW.chain_seq := coalesce(last_seq, 0) + 1;
  NEW.prev_hash := last_hash;
  NEW.hash := audit.event_hash(NEW);
  RETURN NEW;
END $$;

CREATE TRIGGER event_chain BEFORE INSERT ON audit.event
  FOR EACH ROW EXECUTE FUNCTION audit.chain_event();

CREATE FUNCTION audit.forbid_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit.event is append-only';
END $$;

CREATE TRIGGER event_no_update BEFORE UPDATE OR DELETE ON audit.event
  FOR EACH ROW EXECUTE FUNCTION audit.forbid_change();
CREATE TRIGGER event_no_truncate BEFORE TRUNCATE ON audit.event
  FOR EACH STATEMENT EXECUTE FUNCTION audit.forbid_change();

-- Returns the number of events checked and the first broken link (NULL when intact).
CREATE FUNCTION audit.verify_chain() RETURNS TABLE (checked bigint, first_bad_seq bigint) LANGUAGE plpgsql STABLE AS $$
DECLARE
  r audit.event;
  prev bytea := NULL;
  expected_seq bigint := 1;
BEGIN
  checked := 0;
  first_bad_seq := NULL;
  FOR r IN SELECT * FROM audit.event ORDER BY chain_seq LOOP
    checked := checked + 1;
    IF r.chain_seq <> expected_seq OR r.prev_hash IS DISTINCT FROM prev OR r.hash <> audit.event_hash(r) THEN
      first_bad_seq := r.chain_seq;
      RETURN NEXT;
      RETURN;
    END IF;
    prev := r.hash;
    expected_seq := expected_seq + 1;
  END LOOP;
  RETURN NEXT;
END $$;
