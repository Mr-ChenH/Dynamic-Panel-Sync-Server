# Changelog

All notable changes to Dynamic Panel Sync Server are documented here.

## Unreleased

### Added

- Initial self-hosted Sync MVP with multi-account isolation, spaces, per-client one-time Keys, strict-CSP Web console, administrator CLI, typed incremental replication, conflicts, tombstones, realtime invalidation, resumable PNG object transfer, PostgreSQL RLS, encrypted backups, scoped restore, and export jobs.
- Production API and backup-worker composition for PostgreSQL plus filesystem or S3-compatible object and backup storage.

### Fixed

- Persist backup job and operational alert state, run an immediate startup backup, retry failures on a bounded interval, and expose missing, failed, stuck, stale, or unverified backup health through readiness.
- Add forced administrator RLS policies for backup jobs, restore staging data, and operational alerts.
- Add bounded `dynamic-panel-export-v1` file ingestion with exclusive leases, private cryptographic verification, payload-first publication, `COMMITTED.json` as the final marker, dry-run isolation, and resumable post-commit recovery.
- Return authenticated capacity and server identity data required by desktop connection preflight and diagnostics.

### Deferred

- Irreversible purge before the normal tombstone and conflict retention window remains intentionally unavailable pending an explicit backup and object-reference policy.
- Live PostgreSQL, S3, Docker, performance, recovery-drill, and multi-process WebSocket acceptance require dedicated infrastructure.
