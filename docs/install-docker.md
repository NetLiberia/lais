# Running with Docker Compose

> **Unverified.** `Dockerfile`, `docker-compose.yml` and `deploy/nginx.conf` were written for this setup but have **not been built or run**: the development machine has no Docker. The verified setup is the native Windows install in the main README.

## Start

```bash
copy .env.compose.example .env        # Windows; use cp on macOS/Linux
# Edit .env: set POSTGRES_PASSWORD, MFA_ENCRYPTION_KEY (64 hex characters) and SEED_PASSWORD
docker compose up --build
```

- `db` runs PostGIS 15. It is reachable only inside the Compose network.
- `api` applies migrations when it starts, then listens on port 4000 inside the network. Uploaded documents and backups go to the `storage` volume. Its `pg_dump` is version 15, matching the database image.
- `web` serves the built front end on **http://localhost:8080** and proxies `/api` to the API.

Load the synthetic demonstration data once:

```bash
docker compose run --rm api npx tsx src/seed.ts
```

## Notes

- This setup is for demonstration over plain HTTP on one machine. It runs the API with `NODE_ENV=development`, because production mode marks the session cookie `Secure`, which needs HTTPS.
- `TRUST_PROXY=1` makes the API take client addresses from nginx's `X-Forwarded-For`, so rate limits and audit records see the real client.
- If you change the database image to a newer PostgreSQL major version, install the matching `postgresql-client` in the `api` stage of the `Dockerfile`. `pg_dump` refuses to dump a newer server.
- To check a backup restores, set `RESTORE_CHECK_DATABASE_URL` to a disposable database and run `npm run backup:verify -- <file>` in the `api` container (see [backup-restore.md](backup-restore.md)).
