# Deployment and recovery

Co-reader is intended to run behind an HTTPS reverse proxy or a private VPN.
The included Compose configuration binds only to loopback. Do not expose port
4310 directly to the public internet.

## Start

1. Copy `.env.example` to `.env`. Set a strong owner password and generate the
   session secret with `openssl rand -base64 48`.
2. Put provider keys in `.env` or inject them as Docker secrets/environment
   variables. The database stores only their environment-variable names.
3. Run `docker compose up -d --build`, then proxy an HTTPS hostname to
   `127.0.0.1:4310`.

The `co-reader-data` volume contains the WAL-mode SQLite database, immutable
source files, derived assets, and exports. It must be treated as one recovery
unit.

## Consistent backup

Pause writes while copying the volume. The simplest private-instance procedure
is:

```sh
docker compose stop co-reader
docker run --rm -v co-reader-data:/source:ro -v "$PWD/backups:/backup" alpine \
  tar -C /source -czf "/backup/co-reader-$(date +%F-%H%M%S).tar.gz" .
docker compose start co-reader
```

Stopping the service ensures the SQLite database, `-wal` file, and immutable
document tree describe the same point in time. Store the archive encrypted and
test restoration periodically.

## Restore

Restore into a new empty volume first; keep the original volume until the
health check and document assets have been verified.

```sh
docker compose down
docker volume create co-reader-restored
docker run --rm -v co-reader-restored:/target -v "$PWD/backups:/backup:ro" alpine \
  tar -C /target -xzf /backup/CO_READER_BACKUP.tar.gz
```

Temporarily change the Compose volume mapping to `co-reader-restored:/data`,
start the service, sign in, open several documents, and test an export. Only
after that verification should the old volume be retired.

## Upgrade

Take a consistent backup, pull/build the new image, and restart. Database
migrations are forward-only and run at startup. Rolling back the application
may therefore require restoring the pre-upgrade volume snapshot.
