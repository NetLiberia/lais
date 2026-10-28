# -*- coding: utf-8 -*-
"""
Command line for the LAIS ArcMap adapter.

  python lais_sync_cli.py ping
  python lais_sync_cli.py export --fc C:\\data\\survey.gdb\\parcels --case FR-MO-000123 --county MO --map "source_id=PARCEL_NO;land_category=CATEGORY"
  python lais_sync_cli.py upload --package C:\\temp\\FR-MO-000123-1a2b3c4d5e6f.zip --case FR-MO-000123
  python lais_sync_cli.py sync   --fc ... --case ... --county ... --map ...
  python lais_sync_cli.py status --job <job id>

Exports need ArcPy: run them with ArcMap's Python, e.g. C:\\Python27\\ArcGIS10.7\\python.exe.
The server address comes from --url or LAIS_URL; the token from LAIS_SYNC_TOKEN or LAIS_SYNC_TOKEN_FILE.
"""
from __future__ import print_function

import argparse
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import lais_arcmap as lais  # noqa: E402


def main(argv=None):
    p = argparse.ArgumentParser(description='LAIS ArcMap adapter %s' % lais.ADAPTER_VERSION)
    p.add_argument('--url', help='LAIS server address (default: LAIS_URL)')
    sub = p.add_subparsers(dest='command')
    sub.add_parser('ping', help='test the connection and the token')
    for name in ('export', 'sync'):
        s = sub.add_parser(name, help='%s a feature class' % name)
        s.add_argument('--fc', required=True, help='polygon feature class (file geodatabase, shapefile, ...)')
        s.add_argument('--case', required=True, help='LAIS case number')
        s.add_argument('--county', required=True, help='two-letter county code of the case')
        s.add_argument('--map', default='', help='field mapping: target=SourceField;... (targets: %s)' % ', '.join(lais.TARGET_NAMES))
        s.add_argument('--out', help='folder for the package (default: temp)')
        if name == 'sync':
            s.add_argument('--purpose', help='why the data is being sent')
    u = sub.add_parser('upload', help='upload an exported package')
    u.add_argument('--package', required=True)
    u.add_argument('--case', required=True)
    u.add_argument('--purpose')
    st = sub.add_parser('status', help='show a sync job')
    st.add_argument('--job', required=True)
    args = p.parse_args(argv)

    try:
        if args.command == 'ping':
            r = lais.ping(args.url)
            print('Connected as %s. Counties: %s' % (r['user'], ', '.join(c['code'] for c in r['counties']) or 'none'))
        elif args.command == 'export':
            package, manifest = lais.export_package(args.fc, args.case, args.county, lais.parse_mapping(args.map), out_dir=args.out)
            print('Package %s\n%s' % (package, json.dumps(manifest, indent=2, sort_keys=True)))
        elif args.command == 'upload':
            r = lais.upload(args.package, args.case.upper(), purpose=args.purpose, url=args.url)
            print(json.dumps(r, indent=2, sort_keys=True))
        elif args.command == 'sync':
            package, manifest, r = lais.sync(args.fc, args.case, args.county, lais.parse_mapping(args.map), purpose=args.purpose, url=args.url, out_dir=args.out)
            print('Package %s (export %s)' % (package, manifest['export_id']))
            print(json.dumps(r, indent=2, sort_keys=True))
        elif args.command == 'status':
            print(json.dumps(lais.job_status(args.job, args.url), indent=2, sort_keys=True))
        else:
            p.print_help()
            return 2
    except lais.AdapterError as e:
        print('Error: %s' % e, file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
