# -*- coding: utf-8 -*-
"""
LAIS ArcMap adapter: exports a polygon feature class as a LAIS sync package and uploads it.

Runs in ArcMap 10.x (Python 2.7, 32-bit) and in Python 3 (ArcGIS Pro, or without ArcPy for upload and
connection tests only).

Security
  * The adapter never connects to the database and never holds a database password.
  * It authenticates with a personal LAIS sync token (created in LAIS under GIS > ArcMap sync), read from
    the LAIS_SYNC_TOKEN environment variable or from a file only you can read (LAIS_SYNC_TOKEN_FILE, default
    %USERPROFILE%\\.lais\\sync_token). The token is never written to logs, packages or the manifest.
  * Data is sent over HTTPS; plain HTTP is refused except to localhost (development).

Data rules
  * The adapter never assigns or changes a coordinate reference system. The feature class must already be
    in EPSG:4326 (WGS 84) or EPSG:32629 (WGS 84 / UTM 29N); anything else, or an unknown CRS, stops the export.
  * Geometry is exported as it is: nothing is repaired, simplified or reprojected.
  * The export identifier is a hash of the content, so exporting the same data twice gives the same
    identifier, and the server processes it only once (a resend returns the earlier job).
"""
from __future__ import print_function

import datetime
import hashlib
import io
import json
import logging
import os
import shutil
import sys
import tempfile
import time
import uuid
import zipfile

try:  # Python 3
    from urllib.request import Request, urlopen
    from urllib.error import HTTPError, URLError
    from urllib.parse import urlparse
except ImportError:  # Python 2.7 (ArcMap 10.x)
    from urllib2 import Request, urlopen, HTTPError, URLError  # noqa: F401
    from urlparse import urlparse

ADAPTER_VERSION = '1.0.0'
ACCEPTED_SRIDS = {4326: 'WGS 84', 32629: 'WGS 84 / UTM zone 29N'}
MAX_FEATURES = 5000

# Target attribute -> shapefile field written by the adapter (dBASE names are limited to 10 characters).
TARGETS = [
    ('source_id', 'SRC_ID', 'TEXT', 64),
    ('legacy_ref', 'LEGACY_REF', 'TEXT', 64),
    ('land_category', 'LAND_CAT', 'TEXT', 20),
    ('land_use', 'LAND_USE', 'TEXT', 80),
    ('surveyed_area_m2', 'SURV_AREA', 'DOUBLE', None),
    ('holder_names', 'HOLDERS', 'TEXT', 254),
    ('holder_type', 'HOLDER_TYP', 'TEXT', 40),
    ('notes', 'NOTES', 'TEXT', 254),
]
TARGET_NAMES = [t[0] for t in TARGETS]
LAND_CATEGORIES = ('public', 'government', 'customary', 'private')

log = logging.getLogger('lais_arcmap')


class AdapterError(Exception):
    """A problem the user can fix; the message says how."""


# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

def _log_path():
    base = os.environ.get('LOCALAPPDATA') or os.path.expanduser('~')
    folder = os.path.join(base, 'LAIS')
    if not os.path.isdir(folder):
        os.makedirs(folder)
    return os.path.join(folder, 'arcmap-sync.log')


def configure_logging():
    if log.handlers:
        return
    log.setLevel(logging.INFO)
    try:
        handler = logging.FileHandler(_log_path())
        handler.setFormatter(logging.Formatter('%(asctime)s %(levelname)s %(message)s'))
        log.addHandler(handler)
    except (IOError, OSError):
        log.addHandler(logging.NullHandler() if hasattr(logging, 'NullHandler') else logging.StreamHandler())


def server_url(url=None):
    url = (url or os.environ.get('LAIS_URL') or '').strip().rstrip('/')
    if not url:
        raise AdapterError('Set the LAIS server address (LAIS_URL), for example https://lais.example.org')
    parts = urlparse(url)
    if parts.scheme not in ('https', 'http') or not parts.netloc:
        raise AdapterError('LAIS_URL must be an http(s) address')
    if parts.scheme == 'http' and parts.hostname not in ('localhost', '127.0.0.1', '::1'):
        raise AdapterError('Refusing to send data over plain HTTP; use the https:// address of the LAIS server')
    return url


def read_token():
    """The sync token, from LAIS_SYNC_TOKEN or a token file. Never logged or printed."""
    token = os.environ.get('LAIS_SYNC_TOKEN', '').strip()
    source = 'environment'
    if not token:
        path = os.environ.get('LAIS_SYNC_TOKEN_FILE') or os.path.join(os.path.expanduser('~'), '.lais', 'sync_token')
        if not os.path.isfile(path):
            raise AdapterError('No sync token. Create one in LAIS (GIS > ArcMap sync) and put it in LAIS_SYNC_TOKEN '
                               'or in the file %s (readable only by you).' % path)
        if os.name == 'posix' and os.stat(path).st_mode & 0o077:
            raise AdapterError('The token file %s is readable by other users; run: chmod 600 %s' % (path, path))
        with io.open(path, 'r', encoding='utf-8') as f:
            token = f.read().strip()
        source = 'file'
    if not token.startswith('lais_sync_') or len(token) > 120:
        raise AdapterError('The sync token does not look like a LAIS sync token (lais_sync_...)')
    log.info('using sync token ...%s from %s', token[-4:], source)
    return token


# ---------------------------------------------------------------------------
# HTTP (standard library only, so it works in ArcMap's Python 2.7)
# ---------------------------------------------------------------------------

def _request(method, url, token, body=None, content_type=None, timeout=120):
    req = Request(url, data=body)
    req.get_method = lambda: method
    req.add_header('Authorization', 'Bearer ' + token)
    req.add_header('Accept', 'application/json')
    req.add_header('User-Agent', 'lais-arcmap/%s' % ADAPTER_VERSION)
    if content_type:
        req.add_header('Content-Type', content_type)
    try:
        resp = urlopen(req, timeout=timeout)
        return resp.getcode(), json.loads(resp.read().decode('utf-8') or '{}')
    except HTTPError as e:
        try:
            payload = json.loads(e.read().decode('utf-8') or '{}')
        except ValueError:
            payload = {}
        return e.code, payload


def _multipart(fields, file_field, filename, data):
    boundary = '----lais' + uuid.uuid4().hex
    out = io.BytesIO()
    for name, value in fields.items():
        out.write(('--%s\r\nContent-Disposition: form-data; name="%s"\r\n\r\n' % (boundary, name)).encode('utf-8'))
        out.write(value.encode('utf-8') if not isinstance(value, bytes) else value)
        out.write(b'\r\n')
    out.write(('--%s\r\nContent-Disposition: form-data; name="%s"; filename="%s"\r\nContent-Type: application/zip\r\n\r\n'
               % (boundary, file_field, filename)).encode('utf-8'))
    out.write(data)
    out.write(('\r\n--%s--\r\n' % boundary).encode('utf-8'))
    return out.getvalue(), 'multipart/form-data; boundary=' + boundary


def ping(url=None):
    """Connection test: returns the account and the counties the token can sync."""
    configure_logging()
    base, token = server_url(url), read_token()
    try:
        status, payload = _request('GET', base + '/api/gis/arcmap/ping', token, timeout=30)
    except URLError as e:
        raise AdapterError('Cannot reach %s: %s' % (base, getattr(e, 'reason', e)))
    if status != 200:
        raise AdapterError('The server refused the token (%s): %s' % (status, payload.get('error', '')))
    log.info('ping ok as %s', payload.get('user'))
    return payload


def upload(package_path, case_no, purpose=None, url=None, attempts=3):
    """Uploads a package. Retrying is safe: the server recognises an export it has already processed."""
    configure_logging()
    base, token = server_url(url), read_token()
    with open(package_path, 'rb') as f:
        data = f.read()
    fields = {'caseNo': case_no}
    if purpose:
        fields['purpose'] = purpose
    body, ctype = _multipart(fields, 'package', os.path.basename(package_path), data)
    last = None
    for attempt in range(1, attempts + 1):
        try:
            status, payload = _request('POST', base + '/api/gis/arcmap/packages', token, body, ctype, timeout=300)
        except URLError as e:
            last = 'network error: %s' % getattr(e, 'reason', e)
        else:
            if status in (200, 202):
                log.info('uploaded %s for %s: job %s %s', os.path.basename(package_path), case_no, payload.get('job_no'), payload.get('status'))
                return payload
            if status < 500 and status != 429:
                raise AdapterError('The server rejected the package (%s): %s' % (status, payload.get('error', payload)))
            last = 'server answered %s' % status
        log.warning('upload attempt %d failed: %s', attempt, last)
        if attempt < attempts:
            time.sleep(5 * attempt)
    raise AdapterError('Upload failed after %d attempts (%s). It is safe to retry later.' % (attempts, last))


def job_status(job_id, url=None):
    base, token = server_url(url), read_token()
    status, payload = _request('GET', base + '/api/gis/arcmap/jobs/' + job_id, token, timeout=30)
    if status != 200:
        raise AdapterError('Cannot read job %s (%s): %s' % (job_id, status, payload.get('error', '')))
    return payload


# ---------------------------------------------------------------------------
# Export (needs ArcPy)
# ---------------------------------------------------------------------------

def parse_mapping(text):
    """'target=SourceField;target2=Other' -> dict. Targets must be LAIS attributes."""
    mapping = {}
    for part in [p for p in (text or '').replace(',', ';').split(';') if p.strip()]:
        if '=' not in part:
            raise AdapterError('Field mapping entries look like target=SourceField (got "%s")' % part)
        target, source = [x.strip() for x in part.split('=', 1)]
        if target not in TARGET_NAMES:
            raise AdapterError('Unknown target "%s"; use one of: %s' % (target, ', '.join(TARGET_NAMES)))
        mapping[target] = source
    return mapping


def _text(value):
    if value is None:
        return None
    try:
        text = unicode(value)  # noqa: F821 (Python 2)
    except NameError:
        text = str(value)
    return text.strip()


def check_feature_class(arcpy, feature_class, mapping):
    """Checks shape type, CRS and mapped fields. Returns (srid, describe, problems)."""
    if not arcpy.Exists(feature_class):
        raise AdapterError('Feature class not found: %s' % feature_class)
    d = arcpy.Describe(feature_class)
    if getattr(d, 'shapeType', None) != 'Polygon':
        raise AdapterError('The feature class must contain polygons (it contains %s)' % getattr(d, 'shapeType', 'no geometry'))
    sr = d.spatialReference
    srid = int(getattr(sr, 'factoryCode', 0) or 0)
    if not sr or sr.name in ('Unknown', '') or srid == 0:
        raise AdapterError('The coordinate reference system is unknown. The adapter never assigns one: confirm the CRS '
                           'from the survey documentation, define it in ArcCatalog, then export again.')
    if srid not in ACCEPTED_SRIDS:
        raise AdapterError('The data is in %s (EPSG:%s). LAIS accepts EPSG:4326 or EPSG:32629: project the data first '
                           '(Data Management > Projections), check the result, then export.' % (sr.name, srid))
    names = dict((f.name.lower(), f.name) for f in arcpy.ListFields(feature_class))
    # Ordered as TARGETS, so source values line up with the fields written (dicts are unordered in Python 2).
    ordered = [mapping[t] for t in TARGET_NAMES if t in mapping]
    missing = [s for s in ordered if s.lower() not in names]
    if missing:
        raise AdapterError('Mapped field(s) not in the feature class: %s' % ', '.join(missing))
    return srid, d, [names[s.lower()] for s in ordered]


def export_package(feature_class, case_no, county_code, mapping, out_dir=None, source_version=None, arcpy=None):
    """
    Writes <out_dir>/<case_no>-<export id>.zip with a shapefile and manifest.json. Returns
    (package path, manifest). Rows with no geometry are left out and counted in the manifest.
    """
    configure_logging()
    if arcpy is None:
        import arcpy  # noqa: F811 (only available inside ArcGIS)
    case_no = (case_no or '').strip().upper()
    county_code = (county_code or '').strip().upper()
    if not case_no or not county_code or len(county_code) != 2:
        raise AdapterError('Give the LAIS case number and the two-letter county code')
    srid, d, source_fields = check_feature_class(arcpy, feature_class, mapping)
    targets = [t for t in TARGETS if t[0] in mapping]
    oid = d.OIDFieldName

    rows, skipped, warnings = [], 0, []
    digest = hashlib.sha256()
    digest.update(('%s|%s|%s|' % (case_no, county_code, srid)).encode('utf-8'))
    cursor_fields = [oid, 'SHAPE@', 'SHAPE@WKT'] + source_fields
    with arcpy.da.SearchCursor(feature_class, cursor_fields, sql_clause=(None, 'ORDER BY %s' % oid)) as cur:
        for row in cur:
            if row[1] is None:
                skipped += 1
                continue
            values = list(row[3:])
            rows.append((row[1], values))
            digest.update((row[2] or '').encode('utf-8'))
            digest.update(json.dumps([_text(v) for v in values]).encode('utf-8'))
            if len(rows) > MAX_FEATURES:
                raise AdapterError('More than %d features: split the export' % MAX_FEATURES)
    if not rows:
        raise AdapterError('No features with geometry to export')
    for i, (_, values) in enumerate(rows):
        for (target, _, _, _), v in zip(targets, values):
            if target == 'land_category' and v not in (None, '') and _text(v).lower() not in LAND_CATEGORIES:
                warnings.append('Feature %d: land_category "%s" is not public/government/customary/private' % (i + 1, _text(v)))
    if skipped:
        warnings.append('%d row(s) without geometry were left out' % skipped)

    export_id = 'EXP-' + digest.hexdigest()[:32]
    out_dir = out_dir or tempfile.gettempdir()
    work = tempfile.mkdtemp(prefix='lais_')
    try:
        arcpy.CreateFeatureclass_management(work, 'parcels.shp', 'POLYGON', spatial_reference=d.spatialReference)
        shp = os.path.join(work, 'parcels.shp')
        for target, short, ftype, length in targets:
            if ftype == 'TEXT':
                arcpy.AddField_management(shp, short, 'TEXT', field_length=length)
            else:
                arcpy.AddField_management(shp, short, ftype)
        if 'Id' in [f.name for f in arcpy.ListFields(shp)]:
            arcpy.DeleteField_management(shp, 'Id')
        with arcpy.da.InsertCursor(shp, ['SHAPE@'] + [t[1] for t in targets]) as ins:
            for geometry, values in rows:
                out = []
                for (target, _, ftype, length), v in zip(targets, values):
                    if ftype == 'TEXT':
                        t = _text(v)
                        out.append(t[:length] if t else None)
                    else:
                        try:
                            out.append(float(v) if v not in (None, '') else None)
                        except (TypeError, ValueError):
                            raise AdapterError('Feature %d: %s value "%s" is not a number' % (len(out) + 1, target, _text(v)))
                ins.insertRow([geometry] + out)
        manifest = {
            'format': 'lais-arcmap-package',
            'adapter_version': ADAPTER_VERSION,
            'export_id': export_id,
            'case_no': case_no,
            'county_code': county_code,
            'srid': srid,
            'crs_name': d.spatialReference.name,
            'feature_count': len(rows),
            'skipped_without_geometry': skipped,
            'field_map': dict((t[0], t[1]) for t in targets),
            'source_dataset': os.path.basename(feature_class),
            'source_version': source_version,
            'exported_at': datetime.datetime.utcnow().replace(microsecond=0).isoformat() + 'Z',
            'warnings': warnings[:100],
        }
        with io.open(os.path.join(work, 'manifest.json'), 'w', encoding='utf-8') as f:
            f.write(_text(json.dumps(manifest, indent=2, sort_keys=True)))
        package = os.path.join(out_dir, '%s-%s.zip' % (case_no, export_id[4:16]))
        with zipfile.ZipFile(package, 'w', zipfile.ZIP_DEFLATED) as z:
            for name in sorted(os.listdir(work)):
                if os.path.splitext(name)[1].lower() in ('.shp', '.shx', '.dbf', '.prj', '.cpg', '.json'):
                    z.write(os.path.join(work, name), name)
        log.info('exported %s: %d feature(s), EPSG:%s, export %s -> %s', feature_class, len(rows), srid, export_id, package)
        return package, manifest
    finally:
        shutil.rmtree(work, ignore_errors=True)


def sync(feature_class, case_no, county_code, mapping, purpose=None, url=None, out_dir=None, arcpy=None):
    """Export then upload. A failed upload leaves the package on disk so it can be resent."""
    package, manifest = export_package(feature_class, case_no, county_code, mapping, out_dir=out_dir, arcpy=arcpy)
    result = upload(package, manifest['case_no'], purpose=purpose, url=url)
    return package, manifest, result


if __name__ == '__main__':
    sys.exit('Use lais_sync_cli.py or the LAIS toolbox (LAIS.pyt).')
