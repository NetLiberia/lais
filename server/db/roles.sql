-- OPTIONAL hardening script, run manually as a PostgreSQL superuser AFTER migrations.
-- It creates a least-privilege login for the running application, separate from the
-- schema owner that runs migrations. Point DATABASE_URL at lais_app afterwards.
--
--   psql -U postgres -d lais -v ON_ERROR_STOP=1 -v app_password="'choose-a-strong-password'" -f db/roles.sql
--
-- Re-run it after every migration or database rebuild: grants apply to the tables that exist when it
-- runs. It is safe to re-run; an existing lais_app keeps its password.
--
-- The application role cannot change table structure, cannot disable triggers, and cannot
-- UPDATE/DELETE audit events or published history. Verified on PostgreSQL 18 by running the API as
-- lais_app through the browser walkthroughs, including an administrator backup (see docs/security.md).

SELECT format('CREATE ROLE lais_app LOGIN PASSWORD %L', :app_password)
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'lais_app') \gexec

GRANT USAGE ON SCHEMA lais, staging, audit TO lais_app;

GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA lais TO lais_app;
GRANT DELETE ON lais.case_right_proposal TO lais_app;
GRANT DELETE ON lais.session TO lais_app;

GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA staging TO lais_app;

GRANT SELECT, INSERT ON audit.event TO lais_app;
GRANT EXECUTE ON FUNCTION audit.verify_chain() TO lais_app;

-- USAGE draws new numbers; SELECT lets administrator backups (pg_dump runs as this login) read
-- each sequence's current value.
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA lais, staging, audit TO lais_app;

REVOKE ALL ON public.schema_migrations FROM lais_app;
-- Read-only, so administrator backups can include the migration history a restored database needs.
GRANT SELECT ON public.schema_migrations TO lais_app;
