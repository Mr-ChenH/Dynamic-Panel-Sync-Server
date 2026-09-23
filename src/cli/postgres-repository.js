import { withAccountTx, withAdminTx } from '../db/postgres.js';
import { assessBackupJobHealth } from './backup-health.js';

function backupJob(row) {
  return row ? {
    jobId: row.job_id, status: row.status, manifestId: row.manifest_id, errorCode: row.error_code,
    createdAt: row.created_at?.toISOString?.() ?? row.created_at,
    startedAt: row.started_at?.toISOString?.() ?? row.started_at,
    completedAt: row.completed_at?.toISOString?.() ?? row.completed_at
  } : null;
}

export class PostgresOperationsRepository {
  constructor(pool) { this.pool = pool; }
  async getLimits(accountId) {
    const row = (await this.pool.query('SELECT active_spaces,active_clients_per_space FROM structural_limits WHERE account_id=$1', [accountId])).rows[0];
    return { accountId, activeSpaces: row?.active_spaces ?? 10, activeClientsPerSpace: row?.active_clients_per_space ?? 10 };
  }
  async setLimits(accountId, { activeSpaces, activeClientsPerSpace }) {
    if (!Number.isInteger(activeSpaces) || activeSpaces < 1 || activeSpaces > 10 || !Number.isInteger(activeClientsPerSpace) || activeClientsPerSpace < 1 || activeClientsPerSpace > 10) {
      throw Object.assign(new Error('Limits must be integers from 1 through 10'), { code: 'INVALID_ARGUMENT' });
    }
    const result = await this.pool.query(`INSERT INTO structural_limits(account_id,active_spaces,active_clients_per_space) VALUES($1,$2,$3)
      ON CONFLICT(account_id) DO UPDATE SET active_spaces=excluded.active_spaces,active_clients_per_space=excluded.active_clients_per_space
      RETURNING active_spaces,active_clients_per_space`, [accountId, activeSpaces, activeClientsPerSpace]);
    return { accountId, activeSpaces: result.rows[0].active_spaces, activeClientsPerSpace: result.rows[0].active_clients_per_space };
  }
  async usage(accountId, spaceId) {
    const values = [accountId ?? null, spaceId ?? null];
    const result = await withAdminTx(this.pool, { actorType: 'admin', actorId: 'operations' }, (client) => client.query(`SELECT s.account_id,s.space_id,s.name,
      (SELECT count(*) FROM records r WHERE r.account_id=s.account_id AND r.space_id=s.space_id) AS records,
      (SELECT count(*) FROM space_objects o WHERE o.account_id=s.account_id AND o.space_id=s.space_id) AS objects,
      (SELECT coalesce(sum(bytes),0) FROM space_objects o WHERE o.account_id=s.account_id AND o.space_id=s.space_id) AS object_bytes
      FROM spaces s WHERE ($1::uuid IS NULL OR s.account_id=$1) AND ($2::uuid IS NULL OR s.space_id=$2) ORDER BY s.account_id,s.space_id`, values));
    return result.rows.map((row) => ({ accountId: row.account_id, spaceId: row.space_id, name: row.name, records: Number(row.records), objects: Number(row.objects), objectBytes: Number(row.object_bytes) }));
  }
  async audit(accountId, filters = {}) {
    const result = await withAdminTx(this.pool, { actorType: 'admin', actorId: 'operations' }, (client) => client.query(`SELECT event_id,account_id,space_id,actor_type,action,target_type,target_id_prefix,result,error_code,request_id,occurred_at
      FROM audit_events WHERE account_id=$1 AND ($2::uuid IS NULL OR space_id=$2) AND ($3::text IS NULL OR action=$3) ORDER BY occurred_at DESC LIMIT 1000`, [accountId, filters.spaceId ?? null, filters.action ?? null]));
    return result.rows;
  }
  async saveExportJob(job) {
    return withAccountTx(this.pool, { accountId: job.accountId }, async (client) => {
      const row = (await client.query(`INSERT INTO export_jobs(job_id,account_id,space_id,state,result,error_code,created_at,completed_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(job_id) DO UPDATE SET state=excluded.state,result=excluded.result,error_code=excluded.error_code,completed_at=excluded.completed_at
        RETURNING *`, [job.jobId,job.accountId,job.spaceId,job.state,job.result ? JSON.stringify(job.result) : null,job.errorCode ?? null,job.createdAt,job.completedAt ?? null])).rows[0];
      return { jobId: row.job_id, accountId: row.account_id, spaceId: row.space_id, state: row.state, result: row.result, errorCode: row.error_code, createdAt: row.created_at.toISOString(), completedAt: row.completed_at?.toISOString() ?? null };
    });
  }
  async getExportJob(accountId, jobId) {
    return withAccountTx(this.pool, { accountId }, async (client) => {
      const row = (await client.query('SELECT * FROM export_jobs WHERE account_id=$1 AND job_id=$2', [accountId,jobId])).rows[0];
      return row ? { jobId: row.job_id, accountId: row.account_id, spaceId: row.space_id, state: row.state, result: row.result, errorCode: row.error_code, createdAt: row.created_at.toISOString(), completedAt: row.completed_at?.toISOString() ?? null } : undefined;
    });
  }
  async queueBackupJob(job) {
    return withAdminTx(this.pool, { actorType: 'admin', actorId: 'backup-worker' }, async (client) => {
      const scope = job.scope ?? { type: 'server' };
      const row = (await client.query(`INSERT INTO backup_jobs(kind,status,scope_type,account_id,space_id,reason,created_at)
        VALUES('backup','queued',$1,$2,$3,$4,$5) RETURNING job_id`, [scope.type ?? 'server', scope.accountId ?? null, scope.spaceId ?? null, job.reason, job.createdAt])).rows[0];
      return row.job_id;
    });
  }
  async startBackupJob(jobId, job) {
    if (!jobId) return;
    await withAdminTx(this.pool, { actorType: 'admin', actorId: 'backup-worker' }, (client) => client.query(`UPDATE backup_jobs
      SET status='running',started_at=$2 WHERE job_id=$1 AND status='queued'`, [jobId, job.startedAt]));
  }
  async finishBackupJob(jobId, job) {
    if (!jobId) return;
    await withAdminTx(this.pool, { actorType: 'admin', actorId: 'backup-worker' }, async (client) => {
      await client.query(`UPDATE backup_jobs SET status='verified',manifest_id=$2,completed_at=$3,error_code=NULL
        WHERE job_id=$1 AND status='running'`, [jobId, job.point?.manifestId ?? job.point?.id ?? null, job.completedAt]);
      await client.query(`UPDATE operational_alerts SET resolved_at=$1,last_seen_at=$1
        WHERE component='backup' AND code='scheduled_backup_failed' AND resolved_at IS NULL`, [job.completedAt]);
    });
  }
  async failBackupJob(jobId, job) {
    await withAdminTx(this.pool, { actorType: 'admin', actorId: 'backup-worker' }, async (client) => {
      if (jobId) await client.query(`UPDATE backup_jobs SET status='failed',completed_at=$2,error_code=$3
        WHERE job_id=$1 AND status IN ('queued','running','verifying')`, [jobId, job.completedAt, job.errorCode]);
      const details = JSON.stringify({ jobId: jobId ?? null, errorCode: job.errorCode });
      const updated = await client.query(`UPDATE operational_alerts SET severity='critical',details=$1,last_seen_at=$2,resolved_at=NULL
        WHERE component='backup' AND code='scheduled_backup_failed' AND resolved_at IS NULL`, [details, job.completedAt]);
      if (updated.rowCount === 0) await client.query(`INSERT INTO operational_alerts(code,severity,component,details,first_seen_at,last_seen_at)
        VALUES('scheduled_backup_failed','critical','backup',$1,$2,$2)`, [details, job.completedAt]);
    });
  }
  async backupHealth(options) {
    return withAdminTx(this.pool, { actorType: 'admin', actorId: 'backup-health' }, async (client) => {
      const [jobResult, verifiedResult, alertResult] = await Promise.all([
        client.query(`SELECT job_id,status,manifest_id,error_code,created_at,started_at,completed_at
          FROM backup_jobs WHERE kind='backup' ORDER BY created_at DESC LIMIT 1`),
        client.query(`SELECT job_id,status,manifest_id,error_code,created_at,started_at,completed_at
          FROM backup_jobs WHERE kind='backup' AND status='verified' ORDER BY completed_at DESC LIMIT 1`),
        client.query(`SELECT code,severity,details,first_seen_at,last_seen_at FROM operational_alerts
          WHERE component='backup' AND resolved_at IS NULL ORDER BY last_seen_at DESC`)
      ]);
      const alerts = alertResult.rows.map((row) => ({ code: row.code, severity: row.severity, details: row.details, firstSeenAt: row.first_seen_at?.toISOString?.() ?? row.first_seen_at, lastSeenAt: row.last_seen_at?.toISOString?.() ?? row.last_seen_at }));
      return assessBackupJobHealth({ latestJob: backupJob(jobResult.rows[0]), lastVerifiedJob: backupJob(verifiedResult.rows[0]), alerts }, options);
    });
  }
  async migrationStatus() {
    const rows = (await this.pool.query('SELECT version,applied_at FROM schema_migrations ORDER BY version')).rows;
    return { applied: rows };
  }
  async health() {
    try { await this.pool.query('SELECT 1'); return [{ name: 'database', status: 'ok' }]; }
    catch { return [{ name: 'database', status: 'unavailable' }]; }
  }
}
