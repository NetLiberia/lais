# Prompt 4 completion report: LAIS Processor Dashboard, land application management and document processing

Date: 30 October 2026. Environment: Windows 11, PostgreSQL 18.6 with PostGIS 3.6.2, Node.js 24, Microsoft Edge. Synthetic data only.

"Working" below means exercised by the automated tests or the browser walkthrough named in the row. Where a feature is partial, unverified or not implemented, the report says so.

## Results

| Check | Result |
|---|---|
| Server unit tests | 50 passed |
| Server integration tests (147 earlier + 25 new in `processor.test.ts`) | 172 passed |
| Web component tests (31 earlier + 5 new in `Processor.test.tsx`) | 36 passed |
| ESLint, TypeScript, production build | 0 problems, clean, clean |
| Browser walkthroughs (`npm run e2e`, 10 scripts including the new `processor` walkthrough of 15 steps) | 129 steps, 0 problems |

## How it fits the existing system

| Concept | Implementation |
|---|---|
| Land application | Not a parallel table: an application **is a case** (`lais.land_case`), extended with intake fields, an applicant, a configurable category and a responsible processor. Registration, GIS work, supervisory review and the registrar's decision therefore share one record and one history. |
| Applicant | New table, separate from `party` (the legal right holders). |
| Documents, timeline, GIS tasks | The existing documents gained numbers, versions and administrative review. The case history feeds the timeline. GIS handoffs create ordinary GIS tasks, which GIS officers see in My GIS Tasks. |

## Delivered

| Deliverable | Status | Evidence |
|---|---|---|
| 1. Processor Dashboard: 12 KPIs, period and county filter, refresh, last update, own workload | Working | integration test (figures equal SQL counts; other county sees nothing), web tests (figures, error state), walkthrough |
| 2. Registration wizard (5 steps), drafts, unique references, duplicate review | Working | integration tests (valid, duplicate receipt number, required fields, draft, county limits, duplicates), web test (duplicate review), walkthrough |
| 3. Applicant management: search, filters, sort, paging, profile, corrections with history | Working | integration tests (contact privacy, county isolation, previous values kept, identity reveal audited, deletes refused), walkthrough |
| 4. Document Management Center: content sniffing (PDF, PNG, JPEG, TIFF), drag and drop, progress, failure message, versions, preview, repository | Working (TIFF download-only) | integration tests (sniffing, duplicates, download limits, versions, triggers), web test (restricted document), walkthrough (preview, new version) |
| 5. Document Verification: statuses, checks, reasons, referral, history, uploader cannot review | Working | integration tests, walkthrough (second processor accepts) |
| 6. Completeness assessment: configurable fields, documents, conditions, stages; gates; supervisor exceptions | Working | integration tests (missing items, gates on handoff and submission, exception, no decision created), walkthrough |
| 7. Additional information requests: create, deliver, respond, partial, satisfied, reopen, close, overdue | Working (no messaging provider) | integration test (not sent, overdue, history), walkthrough |
| 8. GIS processing handoff: checklist, task creation and linking, notification, history | Working | integration tests (blocked when incomplete, task linked, one open at a time, append-only, no geometry access), walkthrough |
| 9. Returned applications: validation, supervisor, registrar, GIS clarification | Working | integration test (clarification shown until answered), walkthrough |
| 10. Registrar decision tracking (read-only) | Working | integration test (tracking reflects the registrar's record; processor cannot decide, publish or change it), web test, walkthrough |
| 11. Application detail workspace (14 sections, provenance labelled) | Working | walkthrough |
| 12. Workflow timeline from stored events | Working | integration test (sources, order), walkthrough |
| 13. Reports and analytics: charts and 10 reports as JSON, CSV and PDF, filters, no personal data | Working | integration test (all 10 reports, no personal data, PDF), walkthrough (CSV and PDF downloads) |
| 14. Notification center | Working (existing centre with an `application` category); preferences not implemented | integration test (handoff notification) |
| 15. Database migration `013_processor.sql` | Working | applied by every test run |
| 16 and 17. API endpoints (44 new) and OpenAPI | Working | OpenAPI completeness and schema-validation test |
| 18. Automated tests | 25 integration, 5 web, 15-step walkthrough | above |
| 19. Permission matrix | Regenerated (`docs/permission-matrix.md`): 16 new permissions | permission-document test |
| 20. Workflow documentation | [application-processing.md](application-processing.md); [workflow.md](workflow.md), [security.md](security.md) and [database-schema.md](database-schema.md) updated | |
| 21. Installation | No new dependencies or settings; `npm run db:migrate` applies migration 013 | |

## Restrictions on the processor (§3B), as enforced

| Restriction | Where | Tested |
|---|---|---|
| No legal decisions, title approval or publication | Policy (`case.decide`, `case.publish` registrar-only) | yes |
| Registrar decisions cannot be changed | Policy, read-only tracking, trigger freezing intake details of decided cases | yes |
| No geometry editing or GIS validation changes | Policy (no `case.import_geometry`, GIS uploads or corrections) | yes |
| Cannot override GIS or supervisor work | No such routes; exceptions only by supervisors | yes (exception refused to processor) |
| History, documents and audit cannot be deleted or altered | Triggers on cases, case events, documents, applicants, reviews, requests, handoffs, notes, exceptions and configuration changes | yes (database-level attempts refused) |
| No access outside assigned counties | Scope checks on every list and record | yes |
| No restricted documents without permission | Classification-based download rules; titles hidden in lists | yes |
| No self-granted permissions | Unchanged (`roles.assign` administrator-only) | covered by earlier tests |
| "Complete" is not "legally verified" | Separate completeness function; no status implying verification; notices in the interface | yes |

## Bugs found and fixed while building this phase

- **Partial updates cleared fields.** Optional text fields turned "not sent" into "empty", so updating one field cleared the others. Caught by the draft-registration test.
- **Missing survey reference.** The intake survey reference did not feed the case's source reference, which registration validation requires. Caught by the decision test.
- **Untyped report parameters.** A report that did not use the period parameters failed because PostgreSQL could not infer their type.
- **Duplicated timeline events.** Document reviews and information-request steps appeared twice; a task claim showed a raw user id.
- **Wizard on a slow session.** The wizard took its default county before the session had loaded.
- **Layout.** Checkbox labels were laid out vertically in panels.

## Partial, not implemented, unverified

| Item | Status |
|---|---|
| E-mail and SMS to applicants | Not implemented. No provider: requests are labelled *not sent*, and staff record manual delivery. Nothing claims delivery. |
| Notification preferences | Not implemented. |
| Short-lived signed download links | Not needed by the design: files are served only to the signed-in session through the audited route, and previews are temporary in-memory copies. No permanent or public links exist. |
| TIFF preview | Not implemented. Download only; browsers cannot display TIFF. |
| Page navigation and zoom in previews | Provided by the browser's built-in PDF viewer, not by LAIS. |
| Retention and archival schedules | Not implemented. Nothing is deleted; archival needs the authority's policy. |
| District and administrative-area reference data | Free text. |
| Statutory categories and requirements | Not claimed. The seeded rows are working defaults to be replaced by the authority's checklist. |
| Completeness gates for cases opened directly (not through intake) | Not applied. Legacy migrations and earlier cases keep their previous rules. |
| Malware scanning | Not implemented (hook point marked). |
| Browsers other than Edge; load; accessibility audit | Unverified. |
