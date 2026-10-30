-- GeoPackage files can now be imported (read with Node's built-in SQLite; see services/geopackage.ts).
ALTER TABLE staging.import_job DROP CONSTRAINT import_job_source_format_check;
ALTER TABLE staging.import_job ADD CONSTRAINT import_job_source_format_check
  CHECK (source_format IN ('geojson', 'shapefile', 'csv_wkt', 'geopackage', 'arcmap_package', 'working_copy'));
