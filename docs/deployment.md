# Deployment and recovery

ProfRead is intended to run behind an HTTPS reverse proxy or a private VPN.
The included Compose configuration binds only to loopback. Do not expose port
4310 directly to the public internet.

## Start

1. Create a secret env file outside the repository. Set a strong owner password
   and generate the session secret with `openssl rand -base64 48`.
2. Put provider keys in that env file or inject them as Docker
   secrets/environment variables. The database stores only their
   environment-variable names.
3. Run `docker compose --env-file /path/to/afterdraft.env up -d --build`, then
   proxy an HTTPS hostname to `127.0.0.1:4310`.

Compose also starts the internal `academic-worker` conversion sidecar. It has
no host port, credentials, or persistent volume; check that both services are
healthy after a deployment. Only the main ProfRead service should publish
`127.0.0.1:4310`.

The Compose configuration explicitly creates the engine-level
`afterdraft-data` volume. It contains the WAL-mode SQLite database, immutable
source files, academic import jobs and evidence, derived assets, and exports,
and must be treated as one recovery unit. The worker is stateless and does not
add a second backup target.

## Consistent backup

Pause writes while copying the volume. The simplest private-instance procedure
is:

```sh
docker compose --env-file /path/to/afterdraft.env stop afterdraft
docker run --rm -v afterdraft-data:/source:ro -v "$PWD/backups:/backup" alpine \
  tar -C /source -czf "/backup/afterdraft-$(date +%F-%H%M%S).tar.gz" .
docker compose --env-file /path/to/afterdraft.env start afterdraft
```

Stopping the service ensures the SQLite database, `-wal` file, and immutable
document tree describe the same point in time. Store the archive encrypted and
test restoration periodically.

## Restore

Restore into a new empty volume first; keep the original volume until the
health check and document assets have been verified.

```sh
docker volume create afterdraft-restored
docker run --rm -v afterdraft-restored:/target -v "$PWD/backups:/backup:ro" alpine \
  tar -C /target -xzf /backup/AFTERDRAFT_BACKUP.tar.gz
```

Start an isolated validation container with `afterdraft-restored` mounted at
`/data`, sign in over HTTPS, open several documents, and test an export. Do not
stop or overwrite the production volume during a restore test. Only after a
real recovery has been accepted should the old production volume be retired.

## Upgrade

Take a consistent backup, pull/build the new image, and restart. Database
migrations are forward-only and run at startup. Rolling back the application
may therefore require restoring the pre-upgrade volume snapshot.
