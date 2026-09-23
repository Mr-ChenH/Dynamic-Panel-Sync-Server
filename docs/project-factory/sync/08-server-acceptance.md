# Sync Server Acceptance Audit

> Date: 2026-09-23
> Scope: server-owned identity, records, objects, realtime, Web console, backup/restore, admin CLI, production composition, and desktop/server protocol integration.
> Verdict: **PASS for deterministic Sync MVP acceptance; external-infrastructure gates and one explicitly deferred irreversible operation remain open.** The six failures found by the original audit are fixed and retained as regression tests. PostgreSQL, S3, Docker, performance, and macOS evidence is not claimed in this environment. Early permanent purge before the normal retention window remains intentionally unavailable; ordinary tombstone/conflict recovery and retention are enforced.

## 1. Test Entry Points

Default, no external services:

```sh
npm ci
npm test
```

Desktop and real loopback compatibility from a sibling checkout:

```sh
cd ../TO-DO-Panel
npm test
```

The default server run uses Fastify injection, deterministic memory repositories, temporary filesystem backup targets, fixed clocks, and fault injection. The sibling desktop suite can also start this real loopback Fastify server, create account/space/client identities, and exercise desktop protocol clients through HTTP. Set `DYNAMIC_PANEL_SYNC_SERVER_ENTRY` when the repositories are not sibling directories.

Optional PostgreSQL coverage is enabled by `SYNC_TEST_DATABASE_URL`. It creates an isolated schema, applies migrations, runs transaction/RLS checks, and removes the schema. Optional S3 coverage requires `SYNC_TEST_S3_BUCKET` and `SYNC_TEST_S3_REGION`; `SYNC_TEST_S3_ENDPOINT` may target a path-style compatible service.

## 2. Current Results

Server package, final deterministic run:

- 99 tests discovered
- 96 passed
- 0 failed
- 3 optional integrations skipped
- 0 unexpected cancellations

Root desktop package, final deterministic run:

- 501 Node tests discovered
- 500 passed
- 0 failed
- 1 environment-gated skip
- Electron suites passed for notch focus, retained workspace, startup, sync runtime/settings, task notifications, and capture

The three server skips are the optional PostgreSQL concurrency test, optional PostgreSQL migration/RLS test, and optional S3 round trip. They are environment gates, not deterministic failures.

## 3. Accepted Evidence

| Area | Requirement evidence | Result |
| --- | --- | --- |
| Connection preflight and identity | `FR-014`, `FR-015`, `FR-017`, `AC-014`, `AC-015` | `main/sync/sync-service.js:testConnection` authenticates discovery/session, compares instance identity, normalizes capabilities/diagnostics, and refuses a binding token on mismatch. `tests/sync-service.test.js` covers authenticated response midpoint, discovery/session identity mismatch, incompatible capability, and clock skew; `tests/sync-security.test.js` covers discovery contract validation. Deterministic PASS; external TLS/production endpoint remains gated. |
| Management authorization and ID substitution | `FR-009`, `FR-125`, `FR-130`, `NFR-007`, `NFR-018`, `AC-035` | Cross-account IDs match random-missing behavior; Client Keys cannot access account routes; invalid Key variants return generic failures. `test/security-authorization.test.js` and identity/security acceptance suites. Deterministic PASS. |
| Identity and Key lifecycle | `FR-124`, `FR-126`, `FR-143`, `FR-150`, `AC-018`, `AC-037`, `AC-045`, `AC-053` | Recent authentication gates high-risk actions; rotation/reset are atomic under injected failure; disable/re-enable preserves otherwise-valid Keys. |
| No registration or MFA | `FR-003`, `FR-151`, `AC-060` | Registration and MFA route families are absent. |
| Source identity and replay | `FR-029`, `FR-030`, `NFR-004`, `AC-004`, `AC-049`, `AC-050` | 100 replays converge to one accepted operation; changed reuse conflicts; source and scope come from authentication. |
| Record conflict/delete lifecycle | `FR-057`, `FR-064`, `FR-066`, `FR-067`, `AC-005`, `AC-006`, `AC-007` | Concurrent copies remain recoverable; tombstones block stale resurrection; restoration and manual conflict resolution create new revisions. |
| Cursor and restore boundaries | `FR-031`, `FR-040`, `FR-114`, `NFR-011`, `AC-030`, `AC-034` | Stable filtered cursors, reconciliation tokens, expiration, and restore-epoch changes return documented recovery errors without partial advancement. |
| Object authorization and transfer | `FR-070`-`FR-078`, `DR-012`, `DR-017`, `AC-010`, `AC-011`, `AC-023`, `AC-040`, `AC-057` | Multipart resume, PNG verification, scoped opaque IDs, references, range download, rollback, and retention-aware GC pass. |
| Production object metadata | `DR-015`-`DR-017`, `NFR-003`, `NFR-018` | Production composition selects PostgreSQL object/upload/reference metadata when a pool exists; object completion metadata is transactional. |
| Structural limits | `FR-131`, `AC-041`, `AC-055`, `AC-056` | Concurrent memory acceptance has exactly 10 active spaces and 10 active clients; the equivalent live PostgreSQL race remains gated. |
| Backup, scoped restore, export, and import | `FR-101`-`FR-119`, `FR-134`, `AC-025`-`AC-030`, `AC-039`, `AC-048` | `src/backup/**`, `src/jobs/backup.js`, `src/cli/import-package.js`, and operational routes implement encrypted manifests, verified object references, scheduler/job state, portable file staging, and scoped apply. `test/backup-operations.test.js`, `test/import-package.test.js`, `test/cli-operations.test.js`, and fault-injection suites cover corruption/missing artifacts, retention/failure behavior, schedule/retry, health alerts, dry-run/no mutation, strict commit ordering, and scope-bound apply. Deterministic PASS for implemented paths; live PostgreSQL/S3 and quarterly restore drill remain gated. |
| Destructive first sync and category clearing | `FR-023`, `FR-047`-`FR-053`, `AC-013` | Server creates and verifies a scoped encrypted recovery point, signs an impact-bound expiring plan, rechecks revisions, and requires an exact confirmation. Desktop persists and hashes the local typed recovery inventory, rebases local-wins outbox entries, and uses acknowledged projection plus full reconciliation for server-wins. Disabling a category cancels matching transfers; optional server clearing requires a separate recovery-backed `DELETE SERVER CATEGORY DATA` action and tombstones only the selected categories. |
| Backup scheduling and operational alerts | `FR-108`, `FR-109`, `FR-119`, `FR-120` | `src/jobs/backup.js`, `src/cli/backup-health.js`, and `src/routes/health.js` provide daily scheduling, retry/error persistence, alert classification, and layered live/ready health including backup status. `test/backup-operations.test.js` covers scheduler timing, retry/failure persistence, retention/health alert codes; `test/integration-server.test.js` covers backup-degraded readiness and migration/health composition. Deterministic PASS; live operational database/object checks remain gated. |
| Operational RLS context | `NFR-018`, `AC-032`-`AC-040` | `migrations/0006_backup_operations_rls.sql` installs forced admin-only RLS for backup jobs, restore stages/payloads/objects, and operational alerts; operational services use explicit admin/space transaction context. `test/integration-server.test.js` verifies migration policy coverage; `test/identity-postgres.test.js` and PostgreSQL acceptance tests are optional environment gates. Static/deterministic PASS; live PostgreSQL RLS execution remains gated. |
| Export/import, diagnostics and health | `FR-117`, `FR-118`, `FR-119`, `FR-120` | `src/cli/import-package.js` verifies portable package compatibility privately before publishing; `src/cli/backup-health.js` classifies missing/stale/failed/alerted work; `src/routes/health.js` exposes live and componentized ready health. Tests: `test/import-package.test.js`, `test/backup-operations.test.js`, `test/cli-operations.test.js`, and `test/integration-server.test.js`. Deterministic PASS; live PostgreSQL/S3/Docker and production diagnostics remain gated. |
| Web console | `FR-138`-`FR-144`, `NFR-019`, `AC-042`-`AC-047` | Same-origin strict CSP, external assets, CSRF, secure sessions, recent auth, text-safe rendering, one-time Keys, usage/audit/conflict/export views pass static and injected tests. |
| Server composition | `FR-038`-`FR-041`, `FR-070`, `FR-130`, `NFR-018` | Record/object/session/realtime/console/operational routes compose; static configuration and lifecycle checks pass, while live TLS/infrastructure and Docker execution remain gated. |
| Desktop integration | `FR-026`-`FR-053`, `FR-070`-`FR-093` | Per-workspace durable state, ACK-gated projection replay, real object transfer, category filtering, real two-client convergence, destructive replacement, server-wins projection, category clearing, conflict controls, and visible Electron sync settings pass. |
| Windows package acceptance | Existing desktop compatibility contract | NSIS x64 build completed. Fresh install, real launch, IPC, encrypted credentials, fake-media recording/release, notification history, per-tab light-theme screenshots, clean exit, reinstall retention, uninstall, and retained user data passed. Artifact: `Dynamic-Panel-1.1.0-windows-x64-setup.exe`, 125,931,023 bytes, SHA-256 `898301ce591ed02b43d5ba1ff9b28add14ee6470c5481bba8705c429653394ef`. The final remediation root suite also passed 500 tests with one environment-gated skip and all Electron suites. |

## 4. Closed Audit Failures

The original audit found six deterministic failures. All are now regression-tested:

| Original failure | Resolution | Regression evidence |
| --- | --- | --- |
| Key rotation revoked the old Key before replacement commit | `replaceClientKey()` performs replacement atomically in memory and PostgreSQL stores | `FR-124/AC-018` fault-injection test |
| Installation reset could leave no valid Key | Binding clear and Key replacement are one transaction | `FR-150/AC-053` fault-injection test |
| Memory scoped restore replaced only headers | Scoped restore now replaces business collections and object artifacts | `FR-115/FR-134/AC-029/AC-039` test |
| Key actions lacked recent authentication | Create, rotate, revoke, and reset enforce recent auth | `FR-143/AC-045` security test |
| Re-enable invalidated existing Keys | Disable/re-enable no longer mutates Key authentication epoch | `FR-126/AC-037` security test |
| Restore epoch surfaced as `500 internal_error` | Route maps it to stable `409 restore_epoch_changed` | `FR-114/NFR-011` race test |

## 5. Remaining Gates and Deviation

- Live PostgreSQL migrations `0001` through `0006`, forced RLS, `PostgresObjectRepository`, persistent export jobs, conflict operations, and the exact 10/10 transaction race require `SYNC_TEST_DATABASE_URL`.
- S3 object and backup target interoperability requires configured credentials and the explicit S3 test gate.
- Docker/Compose deployment validation is unavailable because Docker is not installed in this environment.
- macOS DMG construction, notarization-related behavior, menu-bar/notch behavior, and Apple Silicon acceptance require a macOS runner.
- `NFR-002`/`AC-002` three-second p95, process-restart soak, long-retention cleanup, and backup RPO/RTO drills require CI/load infrastructure and elapsed-time evidence.
- WebSocket teardown after every revoke/disable race has service-level coverage but should receive a live multi-process socket soak.
- Irreversible early purge before normal tombstone/conflict retention is intentionally deferred. The server preserves the recoverable 30-day lifecycle and does not expose a command or Web action that could silently bypass it.

## 6. Acceptance Decision

The deterministic server and desktop Sync MVP acceptance gate passes with no test failures, and Windows package acceptance passes. Release readiness remains conditional on the external environment gates above. The separately specified irreversible early-purge action is an explicit deferred capability, not an implemented or tested claim; no documentation or UI presents it as available.
