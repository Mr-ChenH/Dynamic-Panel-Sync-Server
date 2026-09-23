# Dynamic Panel Sync Server

Self-hosted synchronization service for Dynamic Panel. It composes the account console, client sync protocol, object transfer, PostgreSQL persistence, realtime invalidations, encrypted exports/backups, restore tooling, and scheduled backup worker.

This is an independent repository. The Electron desktop client lives in [`Mr-ChenH/TO-DO-Panel`](https://github.com/Mr-ChenH/TO-DO-Panel); neither package imports the other at runtime.

## Local smoke run

Node.js 22.13 or newer is required.

```bash
cd Dynamic-Panel-Sync-Server
npm ci
npm test
npm run cli -- --help
npm start
```

Development mode uses in-memory identity, records, and object metadata unless adapters are injected. It is for protocol/UI testing only and must not be treated as durable storage.

## Container image

Every successful push to `main` publishes a multi-architecture image to GitHub Container Registry:

```bash
docker pull ghcr.io/mr-chenh/dynamic-panel-sync-server:latest
```

Images are available for `linux/amd64` and `linux/arm64`. A push to `main` publishes `latest`, `main`, and `sha-<full-commit>` tags. Pushing a version tag such as `v0.2.0` also publishes `0.2.0` and `0.2` tags.

To run the published image with PostgreSQL, persistent object storage, and the backup worker, prepare `.env` and `secrets/postgres_password`, then use the registry-backed Compose file:

```bash
docker compose -f compose.image.yml pull
docker compose -f compose.image.yml up -d
```

`compose.image.yml` defaults to `latest`. Set `DP_SYNC_IMAGE` in `.env` to a version tag or digest to pin a production deployment.

## Production order

1. Set unique `COOKIE_SECRET`, `KEY_LOOKUP_SECRET`, and `CURSOR_SECRET` values of at least 32 characters.
2. Configure PostgreSQL and persistent filesystem or S3 object storage.
3. Configure encrypted backup storage on a separate fault domain and a base64-encoded 32-byte backup master key.
4. Run `npm run migrate` as a one-shot deployment step.
5. Start the API with `npm start` and the required daily backup scheduler with `npm run worker` (or deploy both services from `compose.image.yml`).
6. Create the first account through `npm run cli -- account create --username NAME`, supplying the password through `DP_ADMIN_PASSWORD` or `DP_ADMIN_PASSWORD_FILE`.

Production startup rejects missing database, TLS/proxy trust, persistent object storage, backup target, or backup key configuration. The console is served under `/console/`; liveness and dependency readiness are `/api/v1/health/live` and `/api/v1/health/ready`.

See [deployment.md](docs/deployment.md) for proxy, Docker, PostgreSQL, S3, backup, and recovery details. Implementation design and acceptance evidence live under [`docs/project-factory/sync/`](docs/project-factory/sync/); the canonical product and desktop protocol requirements remain in the desktop repository.
