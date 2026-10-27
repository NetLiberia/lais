/**
 * Spatial conflicts as supervisors see them. A conflict is a validation finding whose rule is listed in
 * lais.conflict_rule. Every validation run stores fresh findings, so one *issue* (same case, rule,
 * related record and feature) is shown once, using its latest occurrence.
 *
 * The review status is derived from evidence, never set by hand:
 *   resolved             a registrar acknowledged it with an investigation note (the authorized review)
 *   closed               no longer detected by the latest validation of the case (corrected), or the case
 *                        was rejected or withdrawn: the disposition is in the case history
 *   escalated            an escalation about it is still open
 *   awaiting_correction  the case was returned, or a supervisor returned it for correction
 *   investigating        an investigation or GIS-check task about it is still open
 *   new                  detected, no action yet
 * A conflict is a technical signal for investigation, not a finding about ownership.
 */
export const CONFLICT_STATUSES = ['new', 'investigating', 'awaiting_correction', 'escalated', 'resolved', 'closed'] as const;
export const OPEN_CONFLICT_STATUSES = ['new', 'investigating', 'awaiting_correction', 'escalated'];

/** Parameters: $1 counties (smallint[] or null). Columns described in the SELECT. */
export const CONFLICTS_SQL = `
WITH latest_run AS (
  SELECT DISTINCT ON (case_id) id, case_id FROM staging.validation_run ORDER BY case_id, run_at DESC
), occurrences AS (
  SELECT DISTINCT ON (run.case_id, f.code, f.related_parcel_id, f.related_case_id, f.feature_index)
         f.id, f.code, f.severity, f.message, f.detail, f.feature_index, f.related_parcel_id, f.related_case_id,
         f.acknowledged_at, f.acknowledgement_note, f.acknowledged_by, run.id AS run_id, run.run_at, run.batch_id, run.case_id
    FROM staging.finding f
    JOIN staging.validation_run run ON run.id = f.run_id
    JOIN lais.conflict_rule r ON r.code = f.code
   ORDER BY run.case_id, f.code, f.related_parcel_id, f.related_case_id, f.feature_index, run.run_at DESC
)
SELECT o.id, o.code, o.severity, o.message, o.detail, o.feature_index, o.related_parcel_id, o.related_case_id,
       o.acknowledged_at, o.acknowledgement_note, au.username AS acknowledged_by,
       o.run_id, o.batch_id, o.case_id, c.case_no, c.case_type, c.status AS case_status, c.county_id, co.code AS county_code,
       rp.upi AS related_upi, rc.case_no AS related_case_no, cp.upi AS case_parcel_upi, c.proposed_upi,
       r.category, r.label AS category_label, r.method, r.rule_version,
       first_seen.at AS detected_at, greatest(o.run_at, ev.at, esc.updated_at, tk.updated_at) AS last_update,
       (lr.id = o.run_id) AS in_latest_run, ev.action AS last_action, ev.note AS last_note,
       tk.id AS task_id, tk.task_no, tk.status AS task_status, tu.username AS investigator,
       esc.id AS escalation_id, esc.escalation_no, esc.status AS escalation_status,
       CASE
         WHEN o.acknowledged_at IS NOT NULL THEN 'resolved'
         WHEN lr.id IS DISTINCT FROM o.run_id OR c.status IN ('rejected', 'withdrawn', 'published') THEN 'closed'
         WHEN esc.status IS NOT NULL AND esc.status <> 'closed' THEN 'escalated'
         WHEN c.status = 'returned' OR ev.action = 'returned_for_correction' THEN 'awaiting_correction'
         WHEN tk.status IS NOT NULL AND tk.status NOT IN ('completed', 'cancelled') THEN 'investigating'
         ELSE 'new'
       END AS review_status
  FROM occurrences o
  JOIN lais.conflict_rule r ON r.code = o.code
  JOIN lais.land_case c ON c.id = o.case_id
  JOIN lais.county co ON co.id = c.county_id
  LEFT JOIN latest_run lr ON lr.case_id = o.case_id
  LEFT JOIN lais.parcel rp ON rp.id = o.related_parcel_id
  LEFT JOIN lais.land_case rc ON rc.id = o.related_case_id
  LEFT JOIN lais.parcel cp ON cp.id = c.parcel_id
  LEFT JOIN lais.app_user au ON au.id = o.acknowledged_by
  -- Review events and tasks follow the issue across re-validations (matched by the same key).
  LEFT JOIN LATERAL (
    SELECT e.action, e.note, e.at, e.task_id FROM lais.conflict_review_event e JOIN staging.finding f2 ON f2.id = e.finding_id
     WHERE e.case_id = o.case_id AND f2.code = o.code AND f2.related_parcel_id IS NOT DISTINCT FROM o.related_parcel_id
       AND f2.related_case_id IS NOT DISTINCT FROM o.related_case_id AND f2.feature_index IS NOT DISTINCT FROM o.feature_index
     ORDER BY e.id DESC LIMIT 1) ev ON true
  LEFT JOIN LATERAL (
    SELECT t.id, t.task_no, t.status, t.assignee_id, t.updated_at FROM lais.task t JOIN staging.finding f3 ON f3.id = t.finding_id
     WHERE t.case_id = o.case_id AND f3.code = o.code AND f3.related_parcel_id IS NOT DISTINCT FROM o.related_parcel_id
       AND f3.feature_index IS NOT DISTINCT FROM o.feature_index
     ORDER BY t.created_at DESC LIMIT 1) tk ON true
  LEFT JOIN lais.app_user tu ON tu.id = tk.assignee_id
  LEFT JOIN LATERAL (
    SELECT x.id, x.escalation_no, x.status, x.updated_at FROM lais.escalation x JOIN staging.finding f4 ON f4.id = x.finding_id
     WHERE x.case_id = o.case_id AND f4.code = o.code AND f4.related_parcel_id IS NOT DISTINCT FROM o.related_parcel_id
       AND f4.feature_index IS NOT DISTINCT FROM o.feature_index
     ORDER BY x.created_at DESC LIMIT 1) esc ON true
  LEFT JOIN LATERAL (
    SELECT min(run2.run_at) AS at FROM staging.finding f5 JOIN staging.validation_run run2 ON run2.id = f5.run_id
     WHERE run2.case_id = o.case_id AND f5.code = o.code AND f5.related_parcel_id IS NOT DISTINCT FROM o.related_parcel_id
       AND f5.related_case_id IS NOT DISTINCT FROM o.related_case_id AND f5.feature_index IS NOT DISTINCT FROM o.feature_index) first_seen ON true
 WHERE ($1::smallint[] IS NULL OR c.county_id = ANY($1))`;
