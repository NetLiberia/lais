# -*- coding: utf-8 -*-
"""
Builds the SYNTHETIC GIS sample datasets with ArcPy (run with ArcMap's Python, e.g.
C:\\Python27\\ArcGIS10.7\\python.exe make_samples.py <output folder>).

Creates a file geodatabase with polygon feature classes in EPSG:4326, EPSG:32629, an unknown CRS and an
unsupported CRS (Web Mercator), then derives the files LAIS tests import:
  synthetic_parcels_4326_shp.zip      shapefile with .prj (WGS 84)
  synthetic_parcels_noprj_shp.zip     the same shapefile without .prj (CRS unknown: must be declared)
  synthetic_parcels_utm29n_shp.zip    shapefile in UTM 29N
  synthetic_parcels_wkt_4326.csv      CSV with a WKT geometry column
  synthetic_arcmap_package.zip        LAIS ArcMap package exported by the adapter
All coordinates are invented and lie inside the synthetic Montserrado pilot boundary.
"""
from __future__ import print_function

import csv
import io
import os
import shutil
import sys
import zipfile

import arcpy

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
import lais_arcmap as lais  # noqa: E402

# Three adjoining synthetic parcels (about 100 m x 100 m) near -10.70, 6.40 (lon, lat).
PARCELS = [
    ('SYN-GIS-001', 'private', 'residential', 10000.0, [(-10.7020, 6.4000), (-10.7011, 6.4000), (-10.7011, 6.4009), (-10.7020, 6.4009)]),
    ('SYN-GIS-002', 'customary', 'agriculture', 10000.0, [(-10.7011, 6.4000), (-10.7002, 6.4000), (-10.7002, 6.4009), (-10.7011, 6.4009)]),
    ('SYN-GIS-003', 'private', 'commercial', 10050.0, [(-10.7002, 6.4000), (-10.6993, 6.4000), (-10.6993, 6.4009), (-10.7002, 6.4009)]),
]
FIELDS = [('PARCEL_NO', 'TEXT', 20), ('CATEGORY', 'TEXT', 20), ('LANDUSE', 'TEXT', 40), ('SURVEYED', 'DOUBLE', None)]


def make_fc(gdb, name, sr, project_to=None):
    fc = os.path.join(gdb, name)
    if arcpy.Exists(fc):
        arcpy.Delete_management(fc)
    arcpy.CreateFeatureclass_management(gdb, name, 'POLYGON', spatial_reference=sr if project_to is None else arcpy.SpatialReference(4326))
    for f, t, n in FIELDS:
        arcpy.AddField_management(fc, f, t, field_length=n) if n else arcpy.AddField_management(fc, f, t)
    with arcpy.da.InsertCursor(fc, ['SHAPE@'] + [f[0] for f in FIELDS]) as cur:
        for no, cat, use, area, ring in PARCELS:
            poly = arcpy.Polygon(arcpy.Array([arcpy.Point(x, y) for x, y in ring + ring[:1]]), arcpy.SpatialReference(4326))
            cur.insertRow([poly, no, cat, use, area])
    if project_to is not None:
        out = fc + '_p'
        if arcpy.Exists(out):
            arcpy.Delete_management(out)
        arcpy.Project_management(fc, out, project_to)
        arcpy.Delete_management(fc)
        arcpy.Rename_management(out, name)
    return fc


def zip_shapefile(folder, stem, target, include_prj=True):
    with zipfile.ZipFile(target, 'w', zipfile.ZIP_DEFLATED) as z:
        for ext in ('.shp', '.shx', '.dbf', '.prj', '.cpg'):
            p = os.path.join(folder, stem + ext)
            if os.path.exists(p) and (include_prj or ext != '.prj'):
                z.write(p, stem + ext)


def main(out):
    if not os.path.isdir(out):
        os.makedirs(out)
    work = os.path.join(out, '_work')
    shutil.rmtree(work, ignore_errors=True)
    os.makedirs(work)
    arcpy.CreateFileGDB_management(work, 'synthetic_parcels.gdb')
    gdb = os.path.join(work, 'synthetic_parcels.gdb')
    wgs = arcpy.SpatialReference(4326)
    fc4326 = make_fc(gdb, 'parcels_4326', wgs)
    fcutm = make_fc(gdb, 'parcels_utm29n', None, project_to=arcpy.SpatialReference(32629))
    make_fc(gdb, 'parcels_webmercator', None, project_to=arcpy.SpatialReference(3857))
    # A copy with its coordinate system removed, to exercise the "unknown CRS" path of the adapter.
    unknown = os.path.join(gdb, 'parcels_unknown_crs')
    arcpy.CreateFeatureclass_management(gdb, 'parcels_unknown_crs', 'POLYGON')
    with arcpy.da.InsertCursor(unknown, ['SHAPE@']) as cur:
        for _, _, _, _, ring in PARCELS:
            cur.insertRow([arcpy.Polygon(arcpy.Array([arcpy.Point(x, y) for x, y in ring + ring[:1]]))])

    shp = os.path.join(work, 'shp')
    os.makedirs(shp)
    arcpy.FeatureClassToFeatureClass_conversion(fc4326, shp, 'synthetic_parcels.shp')
    arcpy.FeatureClassToFeatureClass_conversion(fcutm, shp, 'synthetic_parcels_utm29n.shp')
    zip_shapefile(shp, 'synthetic_parcels', os.path.join(out, 'synthetic_parcels_4326_shp.zip'))
    zip_shapefile(shp, 'synthetic_parcels', os.path.join(out, 'synthetic_parcels_noprj_shp.zip'), include_prj=False)
    zip_shapefile(shp, 'synthetic_parcels_utm29n', os.path.join(out, 'synthetic_parcels_utm29n_shp.zip'))

    with io.open(os.path.join(out, 'synthetic_parcels_wkt_4326.csv'), 'w', encoding='utf-8', newline='') as f:
        f.write(u'parcel_no,category,landuse,surveyed,wkt\n')
        with arcpy.da.SearchCursor(fc4326, ['PARCEL_NO', 'CATEGORY', 'LANDUSE', 'SURVEYED', 'SHAPE@WKT']) as cur:
            for row in cur:
                f.write(u'%s,%s,%s,%s,"%s"\n' % (row[0], row[1], row[2], row[3], row[4]))

    package, manifest = lais.export_package(
        fc4326, 'CASE-SAMPLE-000001', 'MO',
        lais.parse_mapping('source_id=PARCEL_NO;land_category=CATEGORY;land_use=LANDUSE;surveyed_area_m2=SURVEYED'),
        out_dir=work, arcpy=arcpy)
    shutil.copy(package, os.path.join(out, 'synthetic_arcmap_package.zip'))
    print('export id', manifest['export_id'])
    for problem_fc in ('parcels_unknown_crs', 'parcels_webmercator'):
        try:
            lais.export_package(os.path.join(gdb, problem_fc), 'CASE-SAMPLE-000001', 'MO', {}, out_dir=work, arcpy=arcpy)
            print('UNEXPECTED: %s was exported' % problem_fc)
            return 1
        except lais.AdapterError as e:
            print('%s refused as expected: %s' % (problem_fc, e))
    print('gdb', gdb)
    return 0


if __name__ == '__main__':
    sys.exit(main(os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, 'out'))))
