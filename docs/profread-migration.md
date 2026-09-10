# ProfRead deployment migration

The new application uses the `profread` Compose project and main service,
`profread-data:/data`, `/data/profread.sqlite`, `PROFREAD_*` configuration, and
`@profread/*` npm workspaces. All source PDFs, HTML, notes, discussions, model
settings, and exports remain in the same whole-volume recovery unit.

## Prepare

Build and test a committed revision before downtime. Stage the renamed checkout
at `/srv/homelab/apps/profread` and operational scripts from the matching infra
revision. Record the old checkout revision, image IDs, volume, and currently
installed timer configuration. Keep the old checkout, image, secret file, and
volume as the rollback set. Do not run the new Compose file in the old checkout.
Also retain the complete old infra Git revision and copies of its operational
scripts and installed `afterdraft-backup.*` units before replacing any paths;
rollback must not depend on old script names still existing in the new checkout.
Do not delete or prune the old application/worker images during migration.

Before cutover, require passing application tests and both built images, a
successful isolated schema/identity migration rehearsal, enough disk space for
the complete volume and both backup histories, and a clean recorded production
checkout. Existing private bookmarks need no redirect: Tailscale still proxies
the root URL to `127.0.0.1:4310`. Keep `/api/assets`, document/version IDs, and
immutable saved HTML markers intact. GitHub's repository rename is independent
of the running checkout; explicitly update canonical checkout remotes.

Create `/srv/homelab/secrets/profread.env` with
`node scripts/migrate-profread-environment.mjs /srv/homelab/secrets/afterdraft.env /srv/homelab/secrets/profread.env`.
This copies values without printing them, changes only variable names, refuses
an existing destination or duplicate canonical variables, and uses mode 0600.
`PROFREAD_*` takes precedence over legacy `AFTERDRAFT_*` application variables.

## Copy and cut over

1. Disable `afterdraft-backup.timer`, drain active imports and model runs, and
   take a synchronized pre-cutover backup. Stop both old Compose services.
   Confirm the timer's service and all manual backup processes have exited.
   A rehearsal backup is not a cutover snapshot: recheck live counts and make a
   fresh backup after the last accepted write. Keep clients out until the new
   release passes its acceptance checks.
2. Run `bash scripts/migrate-profread-volume.sh profread-profread`. It refuses
   active users of the old volume, a missing/invalid legacy application database,
   and any existing destination. It copies the
   whole volume, verifies every source file's bytes, and opens the copied
   SQLite database through SQLite so committed WAL pages are included in
   `profread.sqlite`. The legacy database and its WAL/SHM companions are retained;
   never rename only the main SQLite file or delete an uncheckpointed WAL.
3. Start the new project from its own checkout. Keep the existing root-mounted
   private Tailscale URL and `127.0.0.1:4310`; no hostname change is needed.
   Verify application and worker health, login, existing document counts,
   representative HTML/PDF source assets, discussions, search, and export.
4. Install `profread-backup.service` and `profread-backup.timer`, preserving
   the 03:00 Asia/Seoul schedule. New local backups go to
   `/srv/homelab/backups/profread`; synchronized copies go to
   `/home/chs/Dropbox/homelab-backups/strixhalo/profread`. Preserve historical
   archives, checksum filenames, and their metadata when carrying them forward.
   Before the first new backup creates those destinations, copy each history
   with these commands while both old and new backup jobs are quiescent:

   ```sh
   node scripts/migrate-profread-backups.mjs /srv/homelab/backups/afterdraft /srv/homelab/backups/profread
   node scripts/migrate-profread-backups.mjs /home/chs/Dropbox/homelab-backups/strixhalo/afterdraft /home/chs/Dropbox/homelab-backups/strixhalo/profread
   ```

   The script refuses existing destinations, preserves every original filename
   and archive/checksum/metadata byte, verifies the full copy, and retains both
   legacy roots. A failed copy retains an incomplete marker and must not be
   treated as an accepted history. Do not overwrite or delete that failed target
   automatically. Historical `imported-html` snapshots remain historical; new
   browsable exports use `imported-library` with all retained PDF versions and
   source-cited discussion reports. Wait for Dropbox synchronization before
   accepting the off-host history. Enable only the new timer after these steps.
5. Create an accepted backup and prove restore into a separate
   `profread-restore-test-*` volume. Update the infrastructure registry with
   actual Git revisions, image IDs, verification results, and recovery paths.
   The renamed restore validator uses no network, synthetic credentials, and
   disabled background jobs; it verifies SQLite integrity/foreign keys, records
   row counts, and opens every HTML/PDF representation for the chosen document.
   Compare restored counts to the synchronized source snapshot, and verify
   representative notes, discussions, assets, and exported PDFs. Its test volume
   must never be the production volume. Do not use the historical validator:
   that script stops the old production service.

## Compatibility and rollback

Existing sessions are accepted and promoted to `profread_session` and
`profread_csrf` without extending their expiry. Browser preferences use new
keys with legacy fallback. Existing saved HTML retains its immutable bytes;
the current reader adds DOM aliases for legacy application markers so old
styles, source references, and annotation anchors remain usable.

Opening an old backup creates `profread.sqlite` using a verified SQLite copy.
An existing `profread.sqlite` always wins; migration never overwrites it with
the legacy snapshot. A failed volume preparation leaves the new target for
inspection instead of automatically deleting it.

Before new production writes, rollback means stopping ProfRead and restarting
the old project on its original volume and credentials. Disable the ProfRead
timer first; restore the captured old operational scripts/units and enable only
the old timer. Recheck old application/worker health and the unchanged private
URL, then confirm old snapshot counts and representative saved sources. Once ProfRead has
accepted writes, preserve a current snapshot and use a data-compatible recovery;
switching back to the pre-cutover volume would omit those new discussions.
Do not delete the original volume or historical backups as part of cutover.
