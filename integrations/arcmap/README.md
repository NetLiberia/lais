# LAIS ArcMap adapter

This adapter sends polygon layers from ArcMap 10.x to LAIS as **sync packages**. Each package becomes a new working version of a LAIS case, and nothing is published by it.

| File | Purpose |
|---|---|
| `LAIS.pyt` | Python toolbox with three tools: *Test connection*, *Export LAIS package* and *Sync to LAIS* |
| `lais_arcmap.py` | The adapter itself: checks, export, manifest, upload |
| `lais_sync_cli.py` | Command line for scripted or offline use |
| `tests/make_samples.py` | Builds the synthetic sample datasets with ArcPy |

## Requirements

| Use | Runtime |
|---|---|
| Toolbox and exports | ArcMap 10.x with its Python 2.7 and ArcPy. Tested on ArcGIS Desktop 10.7.1. |
| Exports (alternative) | ArcGIS Pro, through its Python 3 and ArcPy. |
| Connection test and upload only | Python 2.7 or 3, without ArcPy. |

The adapter uses the Python standard library only. Nothing has to be installed.

## Set-up

1. In LAIS, go to **GIS workspace → ArcMap Sync → Create token**. Copy the token: it is shown once.
2. Give the adapter the server address and the token. Use your user environment, or a file only you can read:

   ```bat
   setx LAIS_URL https://lais.example.org
   rem Either the token itself ...
   setx LAIS_SYNC_TOKEN lais_sync_...
   rem ... or a file:  %USERPROFILE%\.lais\sync_token  (or set LAIS_SYNC_TOKEN_FILE)
   ```

   Never put the token in a map document, a shared folder or a script.
3. In ArcMap, open the Catalog window. Right-click a folder, choose **Add Toolbox**, and pick `LAIS.pyt`.
4. Run **Test connection**. It reports your account and the counties you can sync.

## Use

Run **Sync to LAIS** with these inputs:
- the parcel layer;
- the LAIS case number;
- the two-letter county code;
- a field mapping such as `source_id=PARCEL_NO;legacy_ref=OLD_REF;land_category=CATEGORY`.

The mapping targets are:

| Target | Meaning |
|---|---|
| `source_id` | Feature identifier in your dataset |
| `legacy_ref` | Reference in the legacy register (migration cases) |
| `land_category` | `public`, `government`, `customary` or `private` |
| `land_use` | Land use |
| `surveyed_area_m2` | Surveyed area in square metres |
| `holder_names` | Holder names (migration only) |
| `holder_type` | Holder type (migration only) |
| `notes` | Technical notes |

## How the adapter behaves

- **CRS.** The layer must already be in EPSG:4326 or EPSG:32629. The adapter never defines, assigns or changes a coordinate system. A layer with an unknown CRS, or any other CRS, is refused, and the message explains what to do.
- **Geometry.** Exported exactly as stored. Nothing is repaired, simplified or reprojected.
- **Idempotent.** The export identifier is a hash of the content. The same data gives the same identifier, and the server processes each identifier once per case; a resend returns the earlier job. A failed upload is retried up to three times and can safely be retried later.
- **Credentials.** No database connection and no passwords. The token is never written to logs or packages; the log at `%LOCALAPPDATA%\LAIS\arcmap-sync.log` shows only its last four characters.

Command-line equivalents:

```bat
C:\Python27\ArcGIS10.7\python.exe lais_sync_cli.py ping
C:\Python27\ArcGIS10.7\python.exe lais_sync_cli.py sync --fc C:\data\survey.gdb\parcels --case CASE-2026-000123 --county MO --map "source_id=PARCEL_NO;land_category=CATEGORY"
```

See [docs/arcmap-integration.md](../../docs/arcmap-integration.md) for the full guide and troubleshooting.
