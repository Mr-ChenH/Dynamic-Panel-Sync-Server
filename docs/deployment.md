# Sync Server Deployment

## Network and TLS

Expose the service only through HTTPS. Direct TLS requires both `TLS_CERT_FILE` and `TLS_KEY_FILE`. Behind a reverse proxy, set `TRUST_PROXY` to the smallest trusted proxy address/range and ensure the proxy overwrites `Forwarded` and `X-Forwarded-*` headers. Production rejects requests whose trusted protocol is not HTTPS.

The account console authenticates only with the `HttpOnly`, `Secure`, `SameSite=Lax` session cookie and requires Origin plus CSRF checks on mutations. Sync, object, and realtime routes authenticate only `Authorization: ClientKey ...`. Do not translate one credential type into the other at the proxy.

## Docker Compose

For a registry-backed deployment, create separate runtime and Compose-time configuration files:

```bash
cp .env.example .env
cp .compose.env.example .compose.env
chmod 600 .env .compose.env
```

Replace every required empty value in both files. Generate independent PostgreSQL passwords and a backup key, for example with `openssl rand -hex 32` and `openssl rand -base64 32`. Then validate, pull, and start the stack:

```bash
docker compose --env-file .compose.env -f compose.image.yml config
docker compose --env-file .compose.env -f compose.image.yml pull
docker compose --env-file .compose.env -f compose.image.yml up -d
```

`compose.image.yml` pulls `ghcr.io/mr-chenh/dynamic-panel-sync-server:latest` by default and does not require a local source build. For production, set `DP_SYNC_IMAGE` in `.compose.env` to a release tag such as `ghcr.io/mr-chenh/dynamic-panel-sync-server:0.2.0`, or preferably to an immutable digest. Run the `pull` and `up -d` commands above to deploy an updated image.

To build the image from a local source checkout instead, use:

```bash
docker compose --env-file .compose.env -f compose.example.yml config
docker compose --env-file .compose.env -f compose.example.yml up --build -d
```

Both examples bind the API to loopback by default so a host TLS proxy can front it; `DP_BIND_ADDRESS` and `DP_BIND_PORT` in `.compose.env` control that host binding without changing the fixed container port. Compose-time database passwords and the backup master key are projected as mode `0400` files owned by the fixed non-root application UID; `.compose.env` itself is never passed through the services' `env_file`.

They run a one-shot `database-setup` service before the API. That service alone receives the PostgreSQL administrator secret, creates or updates the non-superuser `dynamic_panel_app` role, applies transactional migrations, and grants runtime data access. The API, worker, and management CLI receive only the application-role secret, so PostgreSQL RLS cannot be bypassed by their connection role.

The long-running application containers run as fixed UID `10001` with a root-owned application directory, drop Linux capabilities, enable `no-new-privileges`, use a bounded `/tmp` tmpfs, rotate Docker JSON logs, and run Node directly for correct signal handling. Docker Compose materializes environment-backed secrets inside the container, so these services cannot use `read_only: true`; the non-root user has write access only to the explicitly mounted data volumes and temporary filesystem.

A separate `backup-worker` uses the same image and environment; keep exactly one worker replica so a scheduled run is not duplicated. Compose waits for the API container to become healthy before starting the worker and disables the image's inherited HTTP healthcheck for non-HTTP services. The worker starts one immediate backup, then defaults to 02:00 UTC daily and can be configured with `DP_BACKUP_HOUR_UTC` and `DP_BACKUP_MINUTE_UTC`. Failed immediate or scheduled runs retry after `DP_BACKUP_RETRY_SECONDS` (60 seconds by default, valid range 1-3600); retries continue at that interval until one succeeds, then scheduling returns to the next daily UTC slot. The examples deliberately use different volumes for online objects and backups, with the worker mounting online objects read-only. Filesystem backup health reports a same-fault-domain warning until `DP_BACKUP_INDEPENDENT_MEDIA=true` is set after the operator has verified that the backup mount is independent.

## PostgreSQL

Outside Compose, run `npm run migrate` before each new server version. Migrations are transactional and tracked in `schema_migrations`; the server never runs them implicitly. Use a migration identity separately from a restricted runtime identity.

Compose enforces that split automatically: `dynamic_panel_admin` is confined to PostgreSQL and the one-shot `database-setup` service, while `dynamic_panel_app` is explicitly created without superuser, role-creation, replication, or `BYPASSRLS` privileges. Database passwords are read from files and URI-encoded by the application, so generated or operator-selected passwords are not interpolated through a shell command. Gate PostgreSQL integration tests behind an operator-provided test URL.

## S3-compatible storage

Set `DP_OBJECT_TARGET=s3` and/or `DP_BACKUP_TARGET=s3`, along with the matching bucket, region, endpoint, and prefix variables. AWS credentials come from the standard AWS SDK credential chain and must not be stored in this repository. Use distinct online and backup buckets; the health service warns when both aliases resolve to the same bucket.

MinIO and other S3-compatible systems may require path-style addressing. Validate multipart/object size limits and lifecycle rules in a staging environment before enabling cleanup. S3/PostgreSQL integration tests are optional and must run only when their explicit environment variables are present.

## Backup and recovery

Backups and exports are encrypted before leaving the process. `DP_BACKUP_MASTER_KEY` must be a base64-encoded 32-byte key, preferably supplied through `DP_BACKUP_MASTER_KEY_FILE` with owner-only permissions. Losing the key makes backups unrecoverable; storing it with the backup defeats fault-domain separation.

Useful commands:

```bash
npm run cli -- backup run
npm run cli -- backup verify MANIFEST_ID
npm run cli -- backup status
npm run cli -- restore stage MANIFEST_ID --dry-run
npm run cli -- restore drill MANIFEST_ID
npm run cli -- restore apply STAGE_ID --account ACCOUNT_ID --space SPACE_ID --confirm RESTORE
npm run cli -- import stage --file /secure/path/dynamic-panel-export-v1.json --dry-run
npm run cli -- import stage EXPORT_MANIFEST_ID --dry-run
npm run cli -- import apply STAGE_ID --account ACCOUNT_ID --space SPACE_ID --confirm IMPORT
npm run cli -- doctor
```

A scheduled run is persisted in `backup_jobs` as it moves through queued, running, and verified or failed states. The worker performs one run immediately at startup before arming its next timer. Readiness degrades when no job is recorded, queued/running/verifying work remains active for more than six hours, the latest job failed, an active backup alert exists, or the last verified job is older than 36 hours. Failures create an active critical `operational_alerts` row; a later verified retry or scheduled run resolves that alert. The `/api/v1/health/ready` response reports backup health as its own component, so monitor both the overall readiness status and `data.components.backup`. Scheduler failures are logged and retained for administrators; the worker uses bounded retry timers without overlapping runs, and shutdown cancels pending timers while draining an active backup before closing PostgreSQL.

Downloaded exports are strict `dynamic-panel-export-v1` JSON packages. Stage one with `--file PATH`; encoded JSON and decoded payload sizes are bounded independently, and only exact relative backup keys and canonical base64 are accepted. `--dry-run` acquires the import lease, writes the package only under a private temporary prefix, cryptographically verifies it, and runs restore compatibility inspection; it then removes the temporary bytes and lease without publishing a point, saving a restore stage, or changing online data.

A non-dry-run import acquires the exclusive target-level `imports/<manifest-id>.lock`, refuses any non-empty destination, publishes payloads without overwriting existing objects, and publishes `COMMITTED.json` last before saving the restore stage. A normal failure before marker publication removes only keys created by that attempt and releases its lease. A process crash before the marker can leave private temporary data, an invisible partial `points/<manifest-id>/` prefix, and the lease; retries fail closed until an operator investigates and removes that specific lease and residue. A crash or stage-save failure after the marker leaves a fully verified, visible recovery point, not an incomplete point; release a stale lease if necessary, then resume stage creation with `import stage MANIFEST_ID`. Never automatically expire leases or broadly delete import prefixes. The legacy manifest-ID form also remains available for exports already present in the target. Apply still requires an explicit scope and exact `--confirm IMPORT`.


Destructive desktop first-sync and optional remote category clearing use the same configured backup target. The server creates and verifies a space-scoped encrypted recovery point before issuing an expiring impact-bound plan; if backup creation or verification is unavailable, the destructive action is rejected without changing records.

## Shutdown and monitoring

`SIGTERM` and `SIGINT` stop accepting traffic, close WebSockets, and drain Fastify before the PostgreSQL pool closes; the worker stops arming new backup timers and closes its pool. Give the containers a termination grace period longer than the 30-second request timeout and any expected backup finalization time. Monitor readiness, backup freshness, active `operational_alerts`, failed verification, database saturation, object storage errors, and disk capacity separately.
