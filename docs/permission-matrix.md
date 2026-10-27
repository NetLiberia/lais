# Permission matrix

<!-- Generated from server/src/authz/policy.ts by `npm run docs:permissions`. Do not edit by hand. -->

Every row is a server-side rule: the API refuses the action (403, audited) for any role without a ✓, whatever the interface shows.
The same matrix is served read-only at `GET /api/admin/permissions` and shown on the Roles & Permissions page.

- **county** scope: the role must be granted for the county of the record. A registrar in Montserrado cannot decide a Margibi case.
- **global** scope: applies nationally.
- **Separation**: `not_contributor` means the person may not act on a case they helped prepare; `creator_only` means only the person who opened it.
- Surveyors have no accounts. The administrator holds no land-record authority: no ✓ on any decision, publication or rights action.

| Action | Description | Admin | GIS | Processor | Registrar | Supervisor | Auditor | Landowner | Scope | Conditions |
|---|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|---|---|
| `case.create` | Open a case in an assigned county |  | ✓ | ✓ |  |  |  |  | county | — |
| `case.view` | View cases in an assigned county |  | ✓ | ✓ | ✓ | ✓ | ✓ |  | county | — |
| `case.edit_attributes` | Edit case details while the case is a draft or returned |  | ✓ | ✓ |  |  |  |  | county | status: draft, returned |
| `case.import_geometry` | Import parcel geometry into staging |  | ✓ |  |  |  |  |  | county | status: draft, returned; case types: first_registration, subdivision, consolidation, correction, migration |
| `case.edit_rights` | Record proposed rights and holders |  |  | ✓ |  |  |  |  | county | status: draft, returned; case types: first_registration, transfer, subdivision, consolidation, confirmation |
| `case.upload_document` | Attach documents and evidence to a case |  | ✓ | ✓ |  |  |  |  | county | status: draft, returned |
| `case.verify_document` | Verify a document uploaded by someone else |  |  | ✓ |  |  |  |  | county | status: draft, returned |
| `case.validate` | Run validation and conflict checks |  | ✓ | ✓ |  |  |  |  | county | status: draft, returned |
| `case.submit` | Submit a case for review |  | ✓ | ✓ |  |  |  |  | county | status: draft, returned |
| `case.withdraw` | Withdraw a case they opened |  | ✓ | ✓ |  |  |  |  | county | status: draft, returned; separation: creator_only |
| `case.acknowledge_finding` | Acknowledge a validation warning with an investigation note |  |  |  | ✓ |  |  |  | county | status: under_review; separation: not_contributor |
| `case.decide` | Approve, return or reject a case (legal decision) |  |  |  | ✓ |  |  |  | county | status: under_review; separation: not_contributor |
| `case.publish` | Publish an approved case to the register |  |  |  | ✓ |  |  |  | county | status: approved; separation: not_contributor |
| `parcel.view_internal` | View internal parcel records (rights, history, cases) |  | ✓ | ✓ | ✓ | ✓ | ✓ |  | county | — |
| `parcel.manage_dispute` | Record and close parcel disputes |  |  |  | ✓ |  |  |  | county | — |
| `document.view_restricted` | Download restricted documents |  | ✓ | ✓ | ✓ | ✓ | ✓ |  | county | — |
| `document.view_highly_sensitive` | Download highly sensitive documents |  |  | ✓ | ✓ |  |  |  | county | — |
| `party.search` | Search party records |  |  | ✓ | ✓ |  |  |  | global | — |
| `party.create` | Record a new party |  |  | ✓ |  |  |  |  | global | — |
| `party.verify_identity` | Verify the identity of a party recorded by someone else |  |  | ✓ |  |  |  |  | global | — |
| `party.link_user` | Link a landowner portal account to a verified party |  |  | ✓ |  |  |  |  | global | — |
| `party.view_sensitive` | Reveal identity numbers and contact details (logged) |  |  | ✓ | ✓ |  |  |  | global | — |
| `audit.view_all` | View the full audit trail |  |  |  |  | ✓ | ✓ |  | global | — |
| `audit.view_technical` | View security and system audit events | ✓ |  |  |  |  |  |  | global | — |
| `user.manage` | Create staff accounts, change their status, reset passwords | ✓ |  |  |  |  |  |  | global | — |
| `users.read` | View staff accounts | ✓ |  |  |  | ✓ |  |  | global | — |
| `roles.assign` | Assign and revoke roles and county assignments for other staff | ✓ |  |  |  |  |  |  | global | — |
| `counties.read` | View county configuration | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |  | global | — |
| `counties.manage` | Configure counties and import administrative boundaries | ✓ |  |  |  |  |  |  | global | — |
| `dashboard.view` | View system-wide operational statistics | ✓ |  |  |  | ✓ |  |  | global | — |
| `gis.sync.read` | Monitor GIS import jobs and their validation outcomes | ✓ |  |  |  | ✓ |  |  | global | — |
| `system.health` | View system health checks | ✓ |  |  |  | ✓ |  |  | global | — |
| `system.configure` | Change non-legal system settings and document categories | ✓ |  |  |  |  |  |  | global | — |
| `backups.run` | Start a database backup | ✓ |  |  |  |  |  |  | global | — |
| `reports.export` | Export administrative reports (no personal data) | ✓ |  |  |  | ✓ |  |  | global | — |
| `docrequest.view` | View landowner document requests |  |  | ✓ | ✓ | ✓ | ✓ |  | county | — |
| `docrequest.prepare` | Prepare documents for release to a landowner |  |  | ✓ |  |  |  |  | county | — |
| `docrequest.decide` | Approve or refuse a document release |  |  |  | ✓ |  |  |  | county | separation: not_contributor |
| `landowner.view_own` | View own registered interests |  |  |  |  |  |  | ✓ | global | — |
| `landowner.request_documents` | Request copies of documents for own parcels |  |  |  |  |  |  | ✓ | global | — |
