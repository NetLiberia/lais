# Database schema

PostgreSQL 15 or later with PostGIS 3. It has been tested on PostgreSQL 18.6 with PostGIS 3.6.2.

Migrations live in `server/db/migrations/` and are applied in order by `npm run db:migrate`, which records each one in `public.schema_migrations`. Geometry is stored in WGS 84 (EPSG:4326). Areas and distances are calculated in UTM zone 29N (EPSG:32629).

## Schema `lais`: records and administration

### Accounts and access

| Table | Purpose | Notes |
|---|---|---|
| `app_user` | Staff and landowner accounts | `status` is invited, active, suspended or deactivated. `password_hash` (scrypt, N=2^15, r=8, p=1, per-user salt) is null only while an account is invited. Email and staff ID are each unique. `mfa_secret_enc` is encrypted with `MFA_ENCRYPTION_KEY`. |
| `role_assignment` | Role grants | Holds a county for county-scoped roles, the grant reason and who granted it. Revocation is recorded; nothing is deleted. |
| `session` | Server-side sessions | Stores the SHA-256 of the token, never the token. Has idle and absolute expiry and a revocation time. |
| `account_token` | One-time activation and password-reset links | Stores the SHA-256 of the token, an expiry (72 h for activation, 24 h for reset), and the time it was used or revoked. |
| `notification` | In-app notifications | |
| `system_setting` | Allow-listed settings | Currently the portal banner, the support contact and the in-app notification switch. |
| `backup_run` | Backup history | Records status, file name, size, SHA-256 and who started it. |

### Counties and reference data

| Table | Purpose | Notes |
|---|---|---|
| `county` | The 15 counties of Liberia | `geom` stays null until a boundary is imported, and `boundary_status` records its state (unconfigured, synthetic, provisional or verified). Each boundary records its source, and who verified it and when. Constraints: an unconfigured county has no geometry; only a county with a boundary can be enabled; a verified boundary must record its provenance. |
| `document_category` | Document types | `system` categories can't be deactivated. `document.doc_type` is a foreign key to this table. |

### Land records

| Table | Purpose | Notes |
|---|---|---|
| `parcel` | Registered parcels (UPI) | Status is active, disputed or retired. Points to its current version. |
| `parcel_version` | Geometry and attributes over time | Rows are never updated in place: a trigger blocks changes except closing `valid_to`. |
| `parcel_lineage` | Parent and child links | Created by subdivision and consolidation. |
| `rrr` | Rights, restrictions and responsibilities | Shares are stored as fractions. Ending a right is recorded by the case that ends it. A trigger protects published rows. |
| `party` | People and organisations | National ID references are masked in lists and revealed only by an audited request. |
| `user_party_link` | Links landowner accounts to parties | |
| `parcel_dispute` | Disputes recorded against a parcel | |

### Cases

| Table | Purpose | Notes |
|---|---|---|
| `land_case` | Applications | Types: first registration, transfer, subdivision, consolidation, correction, legacy migration and confirmation. A trigger enforces the status workflow. |
| `case_event` | Case history | One row per transition or action. |
| `case_decision` | Registrar decisions | Each decision records the validation run it relied on and a snapshot hash. |
| `case_right_proposal` | Rights proposed by a case | Become `rrr` rows when the case is published. |
| `case_source_parcel` | Parcels a case changes | |
| `document` | Supporting documents | Files sit in private storage, with SHA-256, MIME type, classification and verification status. |
| `document_request` | Landowner requests for copies | Has a workflow trigger and a release expiry. |
| `document_request_item` | Documents released under a request | |

### Supervision (migration 010)

| Table | Purpose | Notes |
|---|---|---|
| `land_case.priority`, `land_case.due_date` | Operational priority and due date | Set by supervisors, with the reason recorded in the case history. Outside the decision snapshot. Frozen once the case is closed. |
| `review_issue_category` | Issue categories for returns | Geometry, overlap, boundary, CRS, area, identifier, attributes, documents, stale source, other. |
| `supervisory_review` | Quality reviews: accepted, returned, information requested | Tied to the validation run and staging batch reviewed. A return must name at least one category, and can list affected records. Append-only. |
| `task` | Operational tasks | The type limits who can be assigned it. The status transitions are enforced by `enforce_task_transition`, and deletion is refused. Can link to a case, batch, finding or escalation. |
| `task_event` | Every change to a task | Covers creation, assignment and reassignment (with reason), status changes, priority and due-date changes, comments with references, and follow-ups. It stands in for separate task-assignment and task-comment tables. Append-only. |
| `escalation` | Escalations | Category, severity, the responsible role and level, the county, linked records and verified evidence. Its facts cannot be edited (`protect_escalation`), and closure needs a reason and a closer. |
| `escalation_event` | Escalation history | Opened, acknowledged, assigned, investigation requested, escalated, comment, closed. Append-only. |
| `conflict_rule` | Maps validation rules to conflict categories | The detection method and rule version shown to reviewers. |
| `conflict_review_event` | What supervisors did about a conflict | Note, investigation assigned, GIS check requested, returned for correction, escalated. Append-only. Findings themselves are never edited. |

The append-only tables share the trigger function `lais.forbid_history_change()`. Two settings were added: `workflow.supervisor_review` and `workflow.stage_targets_days` (see [workflow.md](workflow.md)). The notification categories now also include `task`, `escalation` and `review`.

### Application processing (migration 013)

See [application-processing.md](application-processing.md).

| Table or column | Purpose | Notes |
|---|---|---|
| `applicant` | Applicants (`APL-000001`): type, name, optional telephone, e-mail and address, optional identification type and reference, representative, county | Contact and identification are permission-gated. Never deleted (trigger); can be archived. Optional link to a verified `party`. |
| `applicant_change` | Every change to an applicant: field, previous value, new value, reason, officer | Append-only. |
| `application_category` | Configurable categories, each running on one case workflow (`case_type`) | Seeded with working defaults, not a statutory list. |
| `application_requirement` | Required or optional fields and documents per category, with an optional condition and the stage (registration, GIS handoff, submission) | Changes are logged in `application_config_change` (append-only, with a reason). |
| `land_case` intake columns | `applicant_id`, `category_code`, `intake_status` (draft or registered), purpose, submission date, receiving office, office receipt number (unique per county among live applications), declared parcel reference, title or deed reference, location, district, locality, declared land use, declared size and unit, survey reference, remarks, responsible processor | Declared values are unverified. Frozen once the case is decided or withdrawn (`land_case_application_protect`). Cases are never deleted, and `case_event` is now append-only. |
| `application_duplicate_review` | Possible duplicates reviewed at registration, and why the application was registered anyway | Append-only. |
| `document` columns | `document_no` (`DOC-000001`), title, description, `version_no`, `supersedes_id` (unique), `replacement_reason`, `review_status` | `document_protect`: documents are never deleted, their file and identity never change, and a superseded version stays superseded. |
| `document_review_event` | Each administrative review: from and to status, checks made, note, referral, reviewer | Append-only. |
| `info_request`, `info_request_event` | Requests to applicants (`IR-000001`): category, items, explanation, deadline, channel, delivery status (never "sent" without a provider), status; and their history (created, delivered, response recorded with documents, partially satisfied, satisfied, reopened, closed) | Requests are never deleted; events are append-only. |
| `completeness_exception` | A supervisor's justified waiver of named requirements for one stage | Append-only. |
| `application_handoff` | GIS handoffs (`HO-000001`): the GIS task created, instructions, documents, priority, the checklist as it stood, the exception relied on | Append-only. |
| `application_note` | Administrative notes | Append-only. |
| `application_requirement_states()`, `application_completeness()` | SQL functions computing the checklist and the completeness status | One definition for the API, the dashboards and the gates. |

### Views

| View | Purpose |
|---|---|
| `spatial_conflict` | Conflict findings (overlap, duplicate, county mismatch and similar) from the latest validation run of each case. `review_status` is open, acknowledged or closed. |

## Schema `staging`: unpublished GIS submissions

| Table | Purpose |
|---|---|
| `batch` | A numbered **working version** of a case's geometry (`version_no`, unique per case): the file name, its SHA-256, the declared CRS, the feature count, the status (active, superseded or published), `source_kind` (upload, arcmap or correction), the job that created it, `parent_batch_id` and `change_reason`. A new version supersedes the earlier one, which is kept. |
| `feature` | Imported features: the raw and normalised geometry, the result of structural checks, properties, any exclusion and its reason, and the parcel it became when published. Features of a submitted version are frozen (`feature_submitted_protect`), except for the published-parcel link. |
| `import_job` | A GIS processing job (`GIS-000001`), migration 011: an import, ArcMap sync or attribute correction. Records the status, source (name, format, layer, size, SHA-256), CRS detected and declared with any exception reason, adapter version, dataset, export ID and manifest, field mapping, record counts, warnings, rejections, error summary, the version created and `retry_of`. CHECKs: a completed job has a version, and a declared CRS without detection has a reason. One completed job per case and export ID. |
| `submission` | An immutable submission snapshot (`SUB-000001`): the version and validation run submitted, the submitter, the outcome, a summary, the change explanation, outstanding warnings and their acknowledgement, the snapshot hash, the feature count and `previous_submission_id`. Append-only. |
| `validation_rule` | The validation rules: category, default and current severity, `configurable`, fix guidance. A CHECK keeps non-configurable (safety) rules at their default. |
| `rule_set_version` | Append-only history of rule changes (who, when, rule, from, to, reason). Its latest version is the current rule set. |
| `validation_run` | A validation of a batch, with error and warning counts, the rule-set version applied and the county boundary status at the time. |
| `finding` | The findings of a validation run, with any registrar acknowledgement. |

`lais.sync_token` (migration 011) holds ArcMap sync tokens: the owner, a label, the SHA-256 of the token (never the token), the last four characters, expiry, last use and revocation. `lais.task_event` and `lais.conflict_review_event` gained the actions `acknowledged`, `clarification_requested`, `claimed`, `findings_submitted` and `revalidated`.

Nothing in `staging` is authoritative. Geometry reaches `lais.parcel_version` only through the publication of an approved case.

## Schema `audit`

| Object | Purpose |
|---|---|
| `event` | Append-only events. Each records who acted, the action, the outcome (success, denied or failure), the entity, the county, the case, the IP address, and a detail field that includes the `requestId`. Each event carries `prev_hash` and its own `hash`. |
| `chain_event()` trigger | Assigns `chain_seq` and computes the hash, serialised under an advisory lock. |
| `forbid_change()` trigger | Rejects any UPDATE or DELETE. |
| `verify_chain()` | Recomputes every hash. Returns the number of events checked and the first broken sequence number, if any. |

## Integrity triggers

| Trigger | Rule |
|---|---|
| `land_case_transition` | Only allowed status transitions. |
| `parcel_version_protect`, `rrr_protect` | Published history cannot be edited. |
| `document_request_transition`, `document_request_item_protect` | Request workflow, and release items are frozen once decided. |
| `event_chain`, `event_no_update` | The audit chain, and immutability of audit events. |
| `feature_submitted_protect`, `submission_append_only`, `rule_set_version_append_only` | Submitted geometry snapshots, submissions and the rule history cannot be changed. |

## Row-level security

Row-level security is not enabled. The design note is in [security.md](security.md#row-level-security).
