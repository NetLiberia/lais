# Permission matrix

<!-- Generated from server/src/authz/policy.ts by `npm run docs:permissions`. Do not edit by hand. -->

Every row is a server-side rule: the API refuses the action (403, audited) for any role without a ✓, whatever the interface shows.
The same matrix is served read-only at `GET /api/admin/permissions` and shown on the Roles & Permissions page.

- **county** scope: the role must be granted for the county of the record. A registrar in Montserrado cannot decide a Margibi case.
- **national** scope: shows data from every county, so it needs a national grant. A supervisor assigned to one county does not get it.
- **global** scope: needs only the role (reference data, or roles that are national by design).
- Supervision actions are operational. A supervisor's quality acceptance is not a legal approval: supervisors have no ✓ on decisions, publication, rights or geometry.
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
| `audit.view_all` | View the full audit trail |  |  |  |  | ✓ | ✓ |  | national | — |
| `audit.view_county` | View audit events of an assigned county |  |  |  |  | ✓ |  |  | county | — |
| `audit.view_technical` | View security and system audit events | ✓ |  |  |  |  |  |  | global | — |
| `user.manage` | Create staff accounts, change their status, reset passwords | ✓ |  |  |  |  |  |  | global | — |
| `users.read` | View staff accounts | ✓ |  |  |  | ✓ |  |  | national | — |
| `roles.assign` | Assign and revoke roles and county assignments for other staff | ✓ |  |  |  |  |  |  | global | — |
| `counties.read` | View county configuration | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |  | global | — |
| `counties.manage` | Configure counties and import administrative boundaries | ✓ |  |  |  |  |  |  | global | — |
| `dashboard.view` | View system-wide operational statistics | ✓ |  |  |  | ✓ |  |  | national | — |
| `gis.sync.read` | Monitor GIS import jobs and their validation outcomes | ✓ |  |  |  | ✓ |  |  | national | — |
| `system.health` | View system health checks | ✓ |  |  |  | ✓ |  |  | national | — |
| `system.configure` | Change non-legal system settings and document categories | ✓ |  |  |  |  |  |  | global | — |
| `backups.run` | Start a database backup | ✓ |  |  |  |  |  |  | global | — |
| `reports.export` | Export administrative reports (no personal data) | ✓ |  |  |  | ✓ |  |  | national | — |
| `supervision.view` | View operational dashboards, work queues, GIS submissions and conflicts in an assigned county |  |  |  |  | ✓ |  |  | county | — |
| `supervision.review` | Record a quality review of a submitted case: accept, return for correction, or request information (not a legal decision) |  |  |  |  | ✓ |  |  | county | status: under_review |
| `supervision.set_priority` | Set the operational priority and due date of an open case |  |  |  |  | ✓ |  |  | county | status: draft, validating, under_review, returned, approved |
| `conflict.review` | Record notes on spatial conflicts and request investigations or GIS checks (cannot resolve or dismiss them) |  |  |  |  | ✓ |  |  | county | — |
| `task.view` | View operational tasks in an assigned county |  | ✓ | ✓ | ✓ | ✓ | ✓ |  | county | — |
| `task.manage` | Create, assign, reassign, reprioritise, return and cancel operational tasks |  |  |  |  | ✓ |  |  | county | — |
| `task.work` | Work on tasks assigned to oneself: start, block, comment and complete |  | ✓ | ✓ |  | ✓ |  |  | county | — |
| `escalation.view` | View escalations in an assigned county |  |  |  | ✓ | ✓ | ✓ |  | county | — |
| `escalation.view_system` | View escalations routed to system administration | ✓ |  |  |  |  |  |  | global | — |
| `escalation.create` | Raise an escalation in an assigned county |  | ✓ | ✓ | ✓ | ✓ |  |  | county | — |
| `escalation.manage` | Acknowledge, assign, investigate, escalate further and close escalations they are responsible for |  |  |  | ✓ | ✓ |  |  | county | — |
| `escalation.manage_system` | Act on escalations routed to system administration | ✓ |  |  |  |  |  |  | global | — |
| `reports.supervision` | Generate operational quality and compliance reports for an assigned county |  |  |  |  | ✓ | ✓ |  | county | — |
| `docrequest.view` | View landowner document requests |  |  | ✓ | ✓ | ✓ | ✓ |  | county | — |
| `docrequest.prepare` | Prepare documents for release to a landowner |  |  | ✓ |  |  |  |  | county | — |
| `docrequest.decide` | Approve or refuse a document release |  |  |  | ✓ |  |  |  | county | separation: not_contributor |
| `landowner.view_own` | View own registered interests |  |  |  |  |  |  | ✓ | global | — |
| `landowner.request_documents` | Request copies of documents for own parcels |  |  |  |  |  |  | ✓ | global | — |
