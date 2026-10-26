-- OPTIONAL hardening script, run manually as a PostgreSQL superuser AFTER migrations.
-- It creates a least-privilege login for the running application, separate from the
-- schema owner that runs migrations. Point DATABASE_URL at lais_app afterwards.
--
--   psql -U postgres -d lais -v app_password="'choose-a-strong-password'" -f db/roles.sql
--
-- The application role cannot change table structure, cannot disable triggers,
-- and cannot UPDATE/DELETE audit events or published history.

CREATE ROLE lais_app LOGIN PASSWORD :app_password;

GRANT USAGE ON SCHEMA lais, staging, audit TO lais_app;

GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA lais TO lais_app;
GRANT DELETE ON lais.case_right_proposal TO lais_app;
GRANT DELETE ON lais.session TO lais_app;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA lais TO lais_app;

GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA staging TO lais_app;

GRANT SELECT, INSERT ON audit.event TO lais_app;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA audit TO lais_app;
GRANT EXECUTE ON FUNCTION audit.verify_chain() TO lais_app;

REVOKE ALL ON public.schema_migrations FROM lais_app;
