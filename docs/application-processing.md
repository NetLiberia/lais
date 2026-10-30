# Application processing (LAIS processors)

How land applications are registered and processed administratively before GIS work, supervisory quality review and the registrar's decision. This is a research prototype on synthetic data. The categories, requirements and statuses are configurable working defaults, **not** a statement of Liberian law or of the land authority's official checklist.

## Four kinds of information, kept apart

| Kind | Who records it | What it means |
|---|---|---|
| **Applicant-provided** | The applicant, through the processor | Declared and unverified. Examples: the declared parcel reference, location description, land use and size. Labelled as such everywhere. |
| **Administrative** | Processor | Completeness: the configured fields and documents are present, and documents passed an administrative review (readable, complete, consistent). **Not** legal verification. |
| **Technical (GIS)** | GIS officer | Geometry and validation, after a GIS handoff. Processors never upload or edit geometry. |
| **Quality review** | Supervisor | Operational quality control. Not a legal decision. |
| **Legal decision** | Land Registrar | Approval, rejection or return, with authority and a snapshot. Read-only for everyone else. |

The application workspace shows each kind with its own label, and there is no single ambiguous "verified" status.

## Lifecycle of an application

An application is a case (`lais.land_case`) registered through intake. It has an applicant, a configurable category, intake details and a responsible processor. Its **stage** is derived from stored records, never set by hand:

```
registration draft → document review ⇄ awaiting additional information → ready for GIS
   → awaiting GIS (task not started) → GIS processing → GIS work done → under supervisor/registrar review
   → approved / rejected / returned (→ correction → resubmission) → published
```

### 1. Registration

The wizard (**New Application**) has five steps:
1. **Applicant**: find an existing applicant or record a new one. E-mail, telephone and identification are optional: not every applicant has them.
2. **Application**: category, county or registered parcel, purpose, submission date, receiving office, office receipt number, title or deed reference.
3. **Declared parcel**: unverified, and never drawn as geometry.
4. **Documents**.
5. **Review and register**.

At the end of step 3 the application is saved as a **draft**, so documents can attach to it. It can be **registered** only when the registration-stage requirements are met.

- **Unique references.** The application number (`CASE-…`) and the applicant number (`APL-…`) are generated. An office receipt number is unique among live applications of its county; a duplicate is refused.
- **Possible duplicates.** Before anything is created, the system looks for open applications of the same applicant and category, or with the same declared parcel, deed reference or registered parcel. If it finds any, they are shown and nothing is saved. The processor can register anyway only with a reason, kept in `application_duplicate_review`.
- **County.** The county must be one of the processor's own, and enabled. For applications about a registered parcel, the county comes from that parcel, not from the request.

### 2. Documents

- **Formats.** PDF, PNG, JPEG and TIFF, identified from the **file content**, never its name or declared type. Files are stored privately under random names, hashed (SHA-256), and checked against the hash on every read.
- **Duplicates.** The same file twice in the same category is refused.
- **Versions.** A replacement is a **new version** linked to the previous one, with a reason; the old version becomes *superseded*. Documents are never overwritten or deleted, and database triggers enforce both.
- **Preview.** PDF and images are fetched through the authenticated, audited file route and shown from a temporary in-memory copy. There is no permanent link; TIFF is download-only. Highly sensitive documents can be opened only by roles allowed to.

### 3. Administrative document review

Statuses:
- not reviewed, under review;
- accepted for administrative completeness;
- incomplete, unreadable, inconsistent information;
- requires clarification;
- superseded.

| Rule | |
|---|---|
| Separation of duties | The officer who uploaded a document cannot record its acceptance or rejection. |
| Reasons | Incomplete, unreadable, inconsistent and clarification need a reason. |
| Referral | A document that raises a legal question is *referred* for an authorized decision, not judged by the processor. |
| History | Every review is a row in the append-only `document_review_event`, with the checks made (readable, pages present, information present, matches the application). |
| Registrar's checks | The registrar's validation still reads the derived flag: accepted means verified; incomplete, unreadable or inconsistent mean rejected. |

### 4. Completeness

Administrators configure, per category (**Administration → Application Categories**):
- the required **fields**, from a fixed list;
- the required or optional **documents**;
- an optional **condition** (for example, required only when a deed reference is recorded);
- the **stage** by which each must be met: registration, GIS handoff, or submission for review.

Every change needs a reason and is kept in `application_config_change`.

The checklist and the status are computed in one place, the SQL function `lais.application_completeness`. The status is:
- *draft*;
- *awaiting information*: an open information request;
- *incomplete*: something missing, unreadable, incomplete or unclear;
- *ready for administrative review*: everything received, some not yet reviewed;
- *administratively complete*.

| Gate | Rule |
|---|---|
| Registration | Registration-stage requirements must be met. |
| GIS handoff | Registration and handoff-stage requirements must be met. |
| Submission for review (`POST /cases/{id}/submit`) | All mandatory requirements must be met. Without that it is refused (409), with the list. |
| Exceptions | Only a **supervisor** can waive named requirements, for one stage, with a justification of 20 characters or more (`completeness_exception`, append-only, shown to everyone). |

Completeness never creates a decision, verifies an identity or approves a title.

### 5. Additional information requests

A request records:
- the category and what is missing (with document categories);
- an explanation, a deadline and the channel;
- an internal note.

**No e-mail or SMS provider is configured.** E-mail and SMS requests are recorded as *not sent*, and the interface says so. Requests to deliver in person, by letter or by phone are *to be delivered by staff*, who then record the delivery. The system never claims a message was sent.

Statuses: pending, response received, partially satisfied, satisfied, closed. *Overdue* is derived: past the deadline and still open.

Recording a response links documents already uploaded to the application. Reopening and closing need a reason, and the history is append-only.

### 6. GIS handoff

The handoff checklist covers:
- the reference, the registration and the county;
- that the application needs spatial work;
- the applicant details and the declared parcel information;
- the required documents (such as the survey plan), accepted or excepted;
- that no GIS task is already open;
- open information requests, as a warning to mention in the instructions.

The handoff:
- creates a **GIS task**, either assigned to a GIS officer or left in the county queue for any GIS officer to claim;
- links the task to the application and records the checklist as it stood (and any exception relied on) in the append-only `application_handoff`;
- notifies the officer or the queue.

The processor follows the task in the **GIS Processing Queue** and answers clarification requests there. A task's creator can comment on it.

### 7. Returns and corrections

**Returned Applications** lists:
- cases returned by validation, a supervisor or a registrar, with the reason, instructions and issue categories;
- open GIS clarification requests, until the processor answers them.

Corrections:
- change intake details (a registered application needs a reason, and previous values go to the case history);
- replace documents (as new versions);
- answer, then resubmit.

Geometry and registrar decisions are never changed here. Intake details are frozen by a trigger once a case is decided or withdrawn.

### 8. Registrar decision tracking

The tracking statuses are derived from the registrar's own records (`case_decision`, findings acknowledged, supervisor reviews):
- awaiting Registrar review;
- under Registrar review;
- additional information requested;
- approved, rejected, returned for correction.

The page has no decision controls; the API refuses decisions and publication from processors.

## Applicants

Applicants are administrative contacts (`lais.applicant`), separate from parties, the legal right holders. Data is minimised:

- **Contact details.** Telephone, e-mail and address need `applicant.view_contact`. Others see masked values, and search does not match on contact details for them.
- **Identification.** The document type and a reference are collected only if the process requires it. Revealing the reference needs `applicant.view_identity` and is audited.
- **Corrections.** Every change keeps the previous value, the new value, the reason and the officer in the append-only `applicant_change`. Name, type and identity changes need a reason, and the audit trail records which fields changed, never the values. Applicants are never deleted; they can be archived.

## Reports and dashboard

The **Processor Dashboard** has twelve indicators, computed live for the officer's counties and period, each opening a filtered list. Only applications registered through intake are counted.

**Reports and Analytics** offers ten reports as JSON, CSV or PDF:
- registered;
- by category;
- by stage;
- incomplete;
- missing documents;
- information requests;
- handoffs;
- returns;
- processing time;
- awaiting the registrar.

They exclude applicant names, contacts and identification. Each states its filters, scope, generation time and the synthetic-data notice, and each generation is audited.

## Not implemented

- **Applicant notification delivery.** E-mail and SMS are integration placeholders, clearly labelled.
- **Notification preferences.** Not supported; all in-app notifications are delivered.
- **Retention and archival schedules.** Records are kept indefinitely: nothing is deleted. Archival rules need the authority's retention policy.
- **District and administrative-area reference data.** District and locality are free text.
- **Malware scanning of uploads.** Files are type-sniffed and size-limited only.
