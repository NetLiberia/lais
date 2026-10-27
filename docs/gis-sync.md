# GIS synchronization

## What is implemented

The flow is file-based:

1. A GIS officer prepares parcel geometry in ArcMap, ArcGIS Pro or QGIS.
2. They export it as **GeoJSON** in WGS 84 (EPSG:4326) or UTM zone 29N (EPSG:32629). Shapefiles are not accepted directly; export them to GeoJSON first. The officer must declare the CRS on import; if the file also has a `crs` member, it must agree with the declaration. The API refuses data that falls outside Liberia's extent, which catches swapped axes and wrong CRS declarations.
3. They import the file on a case: `POST /api/cases/{id}/geometry`, or the *Import geometry* control on the case page.
4. The import becomes a **staging batch**. Every feature gets structural checks: valid geometry, a polygon, and at least the minimum area.
5. The officer runs **validation**, which checks against the published register:
   - overlap, beyond `OVERLAP_TOLERANCE_M2`;
   - likely duplicates, by Hausdorff distance (`DUPLICATE_HAUSDORFF_M`);
   - county containment;
   - coverage of the parcels being replaced, for subdivision and consolidation;
   - significant boundary change, for corrections.
6. The case is submitted. A registrar reviews the findings, acknowledges any warnings with a note, and decides.
7. **Publication** is the only way geometry enters `lais.parcel_version`. It runs in one transaction under a per-county lock, re-checks the snapshot hash, and records lineage.

## What is not implemented

- **There is no live ArcMap, ArcSDE or ArcGIS Server connection.** Nothing reads from or writes to an Esri geodatabase, and LAIS publishes no feature service.
- **No background queue or scheduler.** Imports and validation run during the request. The *Background jobs* health check therefore reports **unknown**, not healthy.
- **No automatic retry.** There are no queued technical failures to retry. A batch that fails validation is fixed by the GIS officer correcting the data and importing again. The administrator cannot override or re-run validation to force data through.

## Administrator monitoring

**Administration → GIS Synchronization** (`GET /api/admin/gis-jobs`) lists the staging batches. For each one it shows:

- the case and county;
- the file name and its SHA-256;
- the feature count;
- the latest validation result: not validated, passed, warnings, or errors;
- the spatial findings.

Selecting a job opens its findings. The page is read-only. The dashboard card *GIS jobs needing attention* counts active batches that are not yet validated or whose latest validation had errors.

## Before a real integration

- Choose the integration point with the cadastral authority, for example an export from the authority's ArcGIS Enterprise, or a QGIS or FME job that writes GeoJSON.
- Set official tolerances to replace the placeholder thresholds in `server/.env`.
- Replace the synthetic county boundaries with verified ones. County Management records the source and the verifier of each boundary.
- If imports become large, add a job queue. The health check already has a slot for it.
