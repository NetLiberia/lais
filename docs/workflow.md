# Workflow and supervision

This guide covers how applications move through LAIS, where supervisors fit in, and what each supervisory record means. Separation of duties runs through all of it:

- A supervisor's **quality acceptance is not legal approval**.
- Approving, rejecting and publishing stay with the Land Registrar of the county.
- No supervisory action changes geometry, rights or a published record.

Before a case reaches GIS work or review, **processors** register it as an application and process its documents. Their completeness checks are administrative, not legal verification. See [application-processing.md](application-processing.md): registration, document review, completeness gates and exceptions, information requests, the GIS handoff, returns and decision tracking.

## The case workflow

Case statuses are enforced twice: by the API, and by the database trigger `lais.enforce_case_transition`.

```
draft ──submit──▶ validating ──no blocking errors──▶ under_review ──registrar approves──▶ approved ──registrar publishes──▶ published
  │                    │                                │   │                                 │
  │                    └──blocking errors──▶ returned ◀─┘   └──registrar rejects──▶ rejected   └──snapshot changed──▶ under_review
  └──withdraw──▶ withdrawn       (corrected, resubmitted)
                                    ▲
                    supervisor returns for correction (under_review → returned)
```

A typical application goes through these steps:

1. A LAIS processor registers the application and records the rights and documents.
2. A GIS officer imports the geometry into staging.
3. Automated validation and conflict checks run.
4. The officer submits the case. Validation runs again: blocking errors return the case automatically, otherwise it becomes `under_review`.
5. A **supervisor reviews the submission**, then either:
   - **accepts** it, which records that the current validation results meet quality requirements;
   - **returns** it, which moves it to `returned`, records issue categories and affected records, and gives the responsible officer a correction task; or
   - **requests information**, which creates a task whose completion note is the response.
6. The officer corrects the data and resubmits. That creates a new staging batch and a new validation run. The earlier batch, its findings and the supervisory review all stay in the history.
7. The **Land Registrar** of the county acknowledges each warning with a note, then approves, returns or rejects the case. Separation of duties applies: someone who prepared the case cannot decide it.
8. Publication runs in one transaction. It re-checks the decision snapshot, writes new parcel versions and rights, and keeps the history.

## Is quality review required?

The administrator sets `workflow.supervisor_review` in Administration → Settings.

| Value | Effect |
|---|---|
| `optional` (default) | Supervisors may review any submitted case, and a registrar may decide whether or not it has been reviewed. This keeps the workflow that was in place before the Supervisor phase. |
| `required` | For spatial case types (first registration, subdivision, consolidation, correction, migration), a registrar cannot approve until a supervisor has accepted the **current** validation run. Returning or rejecting is never blocked. |

An acceptance is tied to one validation run. After any resubmission the case needs a fresh review.

## Stages shown to supervisors

The dashboard and the work queue group the case statuses into stages. The status is always the source of truth.

| Stage (label) | Case status | Notes |
|---|---|---|
| Draft / in preparation | `draft` | Document review and GIS preparation both happen here. LAIS does not record them as separate states. |
| Automated validation | `validating` | Momentary: a submission is validated within the request. |
| Submitted: supervisory quality review open | `under_review` | A spatial case with no supervisor acceptance of its current validation run. |
| Awaiting Registrar decision | `under_review` | Accepted, or a non-spatial case (transfer, confirmation). In `optional` mode the registrar may also decide cases that are still in quality review. |
| Returned for correction | `returned` | Returned by validation, a supervisor or a registrar. |
| Approved, awaiting publication | `approved` | |
| Published | `published` | |
| Rejected | `rejected` | |
| Withdrawn (archived) | `withdrawn` | |

## Operational targets are not legal deadlines

Two kinds of operational target exist:

- **Due dates.** A supervisor can set one on a case or a task, with a reason, and it is recorded in the history.
- **Stage targets.** The administrator can set target days per status in `workflow.stage_targets_days`, for example `{"under_review": 7}`. No targets are configured by default.

A case is overdue when it is past its due date, or has been longer in its status than the configured target. With no targets configured, only due dates count, and the bottleneck view is labelled *informational*. None of these are statutory or regulatory deadlines.

## Spatial conflicts

Conflicts are validation findings whose rule appears in `lais.conflict_rule`, a table that maps each rule to its category, label, detection method and version. One conflict corresponds to one issue: the same case, rule, related record and feature, followed across re-validations.

Overlaps are measured as the area of the geometric intersection, and anything up to `OVERLAP_TOLERANCE_M2` is ignored. Parcels that only share a boundary have a zero-area intersection, so they never count as a conflict.

The review status is derived from evidence, never set by hand:

| Status | Meaning |
|---|---|
| Newly detected | No action yet. |
| Under investigation | A supervisor assigned an investigation or a GIS check, and the task is still open. |
| Awaiting correction | The case was returned, or the finding was named in a supervisor's return. |
| Escalated | An escalation about it is still open. |
| Resolved after authorized review | A registrar acknowledged it with an investigation note. |
| Closed with documented disposition | Corrected data no longer triggers the rule, or the case was rejected, withdrawn or published. The disposition is in the case history. |

Supervisors can add notes, request investigations or GIS checks (as tasks), return the submission, or escalate. **They cannot resolve or dismiss a conflict.** The evidence (findings, every occurrence, the review events) is never deleted. A conflict is a technical signal, never a determination of ownership or of fraud.

## Tasks

A task is a work item only: it never grants its assignee a permission. A task can only be assigned to an active account that holds a role eligible for its type, in the task's county.

| Type | Eligible roles |
|---|---|
| Document completeness review | Processor |
| GIS data preparation, GIS validation correction | GIS officer |
| Parcel attribute verification, conflict investigation, application follow-up, information request, correction and resubmission | GIS officer or processor |
| Operational quality review | Supervisor |

The allowed status transitions are enforced by the API and by the `lais.enforce_task_transition` trigger:

```
unassigned ─assign─▶ assigned ─start─▶ in_progress ─block─▶ blocked
                        │                  │   ▲──resume──┘
                        └──────complete────┴──▶ completed ─supervisor returns─▶ returned ─start─▶ in_progress
any open status ─supervisor cancels (reason)─▶ cancelled
```

- The assignee starts, blocks (with a note), comments on and completes (with a note) their own tasks.
- The supervisor assigns, reassigns (a reason is required), changes priority and due dates, returns completed work, cancels with a reason, and sends follow-ups.
- Tasks are never deleted, and every change is a `lais.task_event`.

## Escalations

| Category | Routed by default to |
|---|---|
| Repeated GIS data-quality failures, excessive delay, workflow exception | The county supervisor |
| Significant spatial conflict, unresolved document discrepancy | The county Land Registrar |
| Suspected unauthorized modification, synchronization failure, access-control incident | National system administration |

Whoever raises an escalation can pick another permitted target. The responsible role then:

- acknowledges it;
- may assign it to a named person who holds that role;
- may request an investigation, optionally as a task;
- may escalate it further (to a national supervisor, the county registrar or system administration). The new owner must acknowledge it again.

**Closure policy.** An escalation can be closed only if:

- it has been acknowledged;
- the person closing it holds the responsible role;
- every linked task is finished; and
- a reason of at least 10 characters is recorded.

Closing records an operational disposition only. It changes no land record and cannot settle an ownership dispute. The facts of an escalation cannot be edited after it is raised, and its events are append-only.

## What is recorded

Every supervisory action is written to the hash-chained audit trail, with:

- the actor;
- the county;
- the record affected;
- the outcome;
- the reason, where one is required;
- a request ID.

Actions are recorded as follows:

| Area | Audit actions |
|---|---|
| Quality review | `supervision.accept`, `supervision.return`, `supervision.request_info` |
| Case supervision | `supervision.priority`, `supervision.note`, `supervision.follow_up` |
| Conflicts | `conflict.*` |
| Tasks | `task.*`: creation, assignment and reassignment, status changes, priority and due-date changes, comments, follow-ups |
| Escalations | `escalation.*` |
| Reports | `report.supervision`, with the report id, filters and row count |
| Refused access | `authz.denied`, for example a county supervisor asking for another county |

The supervisory records themselves are append-only tables: `lais.supervisory_review`, `lais.task_event`, `lais.escalation_event` and `lais.conflict_review_event`.
