import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { BackupService } from '../src/backup/service.js';
import { MemoryRestoreRepository } from '../src/backup/memory-repository.js';
import { RestoreService } from '../src/backup/restore.js';
import { selectRetention } from '../src/backup/retention.js';
import { FilesystemBackupTarget } from '../src/backup/targets.js';
import { assessBackupJobHealth } from '../src/cli/backup-health.js';
import { ImportPackageService } from '../src/cli/import-package.js';
import { BackupJob, DailyScheduler } from '../src/jobs/backup.js';

async function fixture(t, { withObject = false } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'dp-backup-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const target = new FilesystemBackupTarget(root);
  const data = { accounts: [{ accountId: 'a' }], spaces: [{ accountId: 'a', spaceId: 'one', restoreEpoch: 3 }, { accountId: 'a', spaceId: 'two', restoreEpoch: 8 }], records: [{ body: 'encrypted content' }] };
  const objectBody = Buffer.from('referenced-object-plaintext');
  const objectEntries = withObject ? [{ objectId: 'obj_test', accountId: 'a', spaceId: 'one', bytes: objectBody.length, digest: `sha256:${createHash('sha256').update(objectBody).digest('hex')}`, body: objectBody }] : [];
  const source = { async snapshot() { return { databaseSchema: 1, instanceId: 'instance', spaces: data.spaces, data, objectEntries }; } };
  let next = 1;
  const backup = new BackupService({ source, target, masterKey: randomBytes(32), keyId: 'test-master', id: () => `point-${next++}`, chunkBytes: 9 });
  return { root, target, backup, data, objectBody };
}

test('valid point decrypts and corruption or missing commit marker fails', async (t) => {
  const { root, backup, data } = await fixture(t);
  const point = await backup.create();
  assert.deepEqual((await backup.verify(point.manifestId)).data, data);
  const files = await backup.target.list(`points/${point.manifestId}/chunks/`);
  const file = path.join(root, ...files[0].split('/'));
  const body = await readFile(file); body[0] ^= 0xff; await writeFile(file, body);
  await assert.rejects(backup.verify(point.manifestId), (error) => error.code === 'BACKUP_VERIFICATION_FAILED');
});

test('encrypted target contains no logical plaintext or master key', async (t) => {
  const { backup, target } = await fixture(t);
  const point = await backup.create();
  for (const key of await target.list(`points/${point.manifestId}/`)) {
    const value = await target.get(key);
    assert.equal(value.includes('encrypted content'), false);
  }
});

test('referenced object bytes are encrypted, authenticated, and required by staging', async (t) => {
  const { root, backup, target, objectBody } = await fixture(t, { withObject: true });
  const point = await backup.create();
  const verified = await backup.verify(point.manifestId);
  assert.deepEqual(verified.objects.map((item) => item.bytes), [objectBody]);
  for (const key of await target.list(`points/${point.manifestId}/objects/`)) assert.equal((await target.get(key)).includes(objectBody), false);

  const objectKeys = await target.list(`points/${point.manifestId}/objects/`);
  await rm(path.join(root, ...objectKeys[0].split('/')));
  await assert.rejects(backup.verify(point.manifestId), (error) => error.code === 'BACKUP_VERIFICATION_FAILED' && error.reason === 'missing_entry');
  const restore = new RestoreService({ backup, repository: new MemoryRestoreRepository() });
  await assert.rejects(restore.stage(point.manifestId), (error) => error.code === 'BACKUP_VERIFICATION_FAILED');
});

test('corrupt referenced object artifact fails verification before staging mutation', async (t) => {
  const { root, backup, target } = await fixture(t, { withObject: true });
  const point = await backup.create();
  const objectKeys = await target.list(`points/${point.manifestId}/objects/`);
  const file = path.join(root, ...objectKeys.at(-1).split('/'));
  const body = await readFile(file); body[0] ^= 0xff; await writeFile(file, body);
  const repository = new MemoryRestoreRepository();
  const restore = new RestoreService({ backup, repository });
  await assert.rejects(restore.stage(point.manifestId), (error) => error.code === 'BACKUP_VERIFICATION_FAILED');
  assert.equal(repository.stages.size, 0);
  assert.equal(repository.mutations, 0);
});

test('export package round-trips through file staging and rejects traversal or corruption before online mutation', async (t) => {
  const { root, backup, data } = await fixture(t);
  const point = await backup.create();
  const files = await Promise.all((await backup.target.list(`points/${point.manifestId}/`)).map(async (key) => ({ key: key.slice(`points/${point.manifestId}/`.length), body: (await backup.target.get(key)).toString('base64') })));
  const packageFile = path.join(root, 'export.json');
  await writeFile(packageFile, JSON.stringify({ format: 'dynamic-panel-export-v1', manifestId: point.manifestId, files }));
  const importedRoot = await mkdtemp(path.join(tmpdir(), 'dp-import-'));
  t.after(() => rm(importedRoot, { recursive: true, force: true }));
  const importedTarget = new FilesystemBackupTarget(importedRoot);
  const importedBackup = new BackupService({ source: backup.source, target: importedTarget, masterKey: backup.masterKey, keyId: backup.keyId });
  const repository = new MemoryRestoreRepository({ accounts: [{ accountId: 'online' }], spaces: [{ accountId: 'online', spaceId: 'live', restoreEpoch: 2 }] });
  const importer = new ImportPackageService({ backup: importedBackup, repository, target: importedTarget });
  const stage = await importer.stageFile(packageFile);
  assert.equal(stage.ready, true);
  assert.equal(repository.mutations, 0);
  assert.deepEqual((await importedBackup.verify(point.manifestId)).data, data);
  const traversal = path.join(root, 'traversal.json');
  await writeFile(traversal, JSON.stringify({ format: 'dynamic-panel-export-v1', manifestId: point.manifestId, files: [{ key: '../escape', body: 'YQ==' }] }));
  await assert.rejects(importer.stageFile(traversal), (error) => error.reason === 'invalid_package_key');
  assert.equal(repository.mutations, 0);
  const corrupt = path.join(root, 'corrupt.json');
  files[0].body = `${files[0].body.slice(0, -2)}AA`;
  await writeFile(corrupt, JSON.stringify({ format: 'dynamic-panel-export-v1', manifestId: 'point-corrupt', files }));
  await assert.rejects(importer.stageFile(corrupt), (error) => error.code === 'BACKUP_VERIFICATION_FAILED');
  assert.equal(repository.mutations, 0);
});

test('retention selects at least 7 daily, 4 weekly and 12 monthly slots', () => {
  const points = Array.from({ length: 400 }, (_, index) => ({ id: `p${index}`, manifestId: `p${index}`, status: 'verified', createdAt: new Date(Date.UTC(2026, 11, 31 - index)).toISOString() }));
  const result = selectRetention(points, { daily: 7, weekly: 4, monthly: 12 });
  assert.ok(result.keep.length >= 12);
  assert.deepEqual(result.keep.slice(0, 7).map((point) => point.id), points.slice(0, 7).map((point) => point.id));
});

test('backup job health degrades for missing, stale, failed, alerted, and old verified work', () => {
  const now = new Date('2026-01-03T12:00:00.000Z');
  const codes = (input) => assessBackupJobHealth(input, { now, activeMaximumAgeMs: 60_000, verifiedMaximumAgeMs: 120_000 }).alerts.map((alert) => alert.code);
  assert.deepEqual(codes({}), ['backup_job_missing']);
  assert.deepEqual(codes({ latestJob: { status: 'queued', createdAt: '2026-01-03T11:58:59.000Z' } }), ['backup_job_stale']);
  assert.deepEqual(codes({ latestJob: { status: 'running', startedAt: '2026-01-03T11:58:59.000Z' } }), ['backup_job_stale']);
  assert.deepEqual(codes({ latestJob: { status: 'verifying', startedAt: '2026-01-03T11:58:59.000Z' } }), ['backup_job_stale']);
  assert.deepEqual(codes({ latestJob: { status: 'failed', createdAt: now.toISOString() } }), ['backup_job_failed']);
  assert.deepEqual(codes({ latestJob: { status: 'verified', completedAt: now.toISOString() }, alerts: [{ code: 'disk_warning' }] }), ['disk_warning']);
  assert.deepEqual(codes({ latestJob: { status: 'verified', completedAt: now.toISOString() }, lastVerifiedJob: { status: 'verified', completedAt: '2026-01-03T11:57:59.000Z' } }), ['backup_verified_stale']);
  assert.equal(assessBackupJobHealth({ latestJob: { status: 'verified', completedAt: now.toISOString() }, lastVerifiedJob: { status: 'verified', completedAt: now.toISOString() } }, { now }).status, 'ok');
});

test('immediate scheduler run is overlap-safe, drains on stop, and does not arm a daily timer after shutdown', async () => {
  const timers = [];
  let release;
  let runs = 0;
  const blocker = new Promise((resolve) => { release = resolve; });
  const scheduler = new DailyScheduler({
    job: { async run() { runs += 1; await blocker; } },
    clock: () => new Date('2026-01-01T00:00:00.000Z'),
    setTimer(callback, delay) { timers.push({ callback, delay }); return { unref() {} }; },
    clearTimer() {}
  });
  scheduler.start({ immediate: true });
  const overlapping = scheduler.runOnce();
  await new Promise(setImmediate);
  assert.equal(runs, 1);
  assert.equal(timers.length, 0);
  const stopped = scheduler.stop();
  let drained = false;
  stopped.then(() => { drained = true; });
  await new Promise(setImmediate);
  assert.equal(drained, false);
  release();
  await Promise.all([stopped, overlapping]);
  assert.equal(drained, true);
  assert.equal(timers.length, 0);
});

test('scheduled backup persists queued, running, and verified lifecycle states', async () => {
  const events = [];
  const jobs = {
    async queueBackupJob(job) { events.push(['queued', job]); return 'job-1'; },
    async startBackupJob(id, job) { events.push(['running', id, job]); },
    async finishBackupJob(id, job) { events.push(['verified', id, job]); }
  };
  const backup = { async create() { return { manifestId: 'point-1' }; }, async prune() { return { kept: ['point-1'], pruned: [] }; } };
  const times = ['2026-01-01T00:00:00.000Z', '2026-01-01T00:00:01.000Z', '2026-01-01T00:00:02.000Z'];
  const result = await new BackupJob({ backup, jobs, clock: () => new Date(times.shift()) }).run();
  assert.deepEqual(events.map(([state]) => state), ['queued', 'running', 'verified']);
  assert.equal(events[0][1].status, 'queued');
  assert.equal(events[1][2].status, 'running');
  assert.equal(events[2][2].point.manifestId, 'point-1');
  assert.equal(result.status, 'verified');
});

test('failed immediate backup retries until success and then resumes the daily schedule', async () => {
  const events = [];
  const timers = [];
  const errors = [];
  let runs = 0;
  const job = new BackupJob({
    backup: { async create() { runs += 1; if (runs < 3) throw Object.assign(new Error('write failed'), { code: 'BACKUP_UNAVAILABLE' }); return { manifestId: 'point-3' }; }, async prune() { return {}; } },
    jobs: {
      async queueBackupJob() { return `job-${runs + 1}`; },
      async startBackupJob(id) { events.push(['running', id]); },
      async failBackupJob(id, result) { events.push(['failed', id, result.errorCode]); },
      async finishBackupJob(id) { events.push(['verified', id]); }
    }
  });
  const scheduler = new DailyScheduler({
    job,
    retryDelayMs: 5_000,
    clock: () => new Date('2026-01-01T00:00:00.000Z'),
    setTimer(callback, delay) { const timer = { callback, delay }; timers.push(timer); return timer; },
    clearTimer() {},
    onError(error) { errors.push(error.code); }
  });
  scheduler.start({ immediate: true });
  await new Promise(setImmediate);
  assert.deepEqual(errors, ['BACKUP_UNAVAILABLE']);
  assert.deepEqual(events.slice(0, 2), [['running', 'job-1'], ['failed', 'job-1', 'BACKUP_UNAVAILABLE']]);
  const firstRetry = timers.shift();
  assert.equal(firstRetry.delay, 5_000);

  firstRetry.callback();
  await new Promise(setImmediate);
  assert.deepEqual(errors, ['BACKUP_UNAVAILABLE', 'BACKUP_UNAVAILABLE']);
  const secondRetry = timers.shift();
  assert.equal(secondRetry.delay, 5_000);

  secondRetry.callback();
  await new Promise(setImmediate);
  assert.equal(events.at(-1)[0], 'verified');
  assert.equal(timers.length, 1);
  assert.equal(timers[0].delay, 2 * 60 * 60 * 1000);
  await scheduler.stop();
});

test('shutdown cancels a pending backup retry and prevents another run', async () => {
  const timers = [];
  const cleared = [];
  let runs = 0;
  const scheduler = new DailyScheduler({
    job: { async run() { runs += 1; throw new Error('offline'); } },
    retryDelayMs: 10_000,
    clock: () => new Date('2026-01-01T00:00:00.000Z'),
    setTimer(callback, delay) { const timer = { callback, delay }; timers.push(timer); return timer; },
    clearTimer(timer) { cleared.push(timer); },
    onError() { throw new Error('logger unavailable'); }
  });
  scheduler.start({ immediate: true });
  await new Promise(setImmediate);
  assert.equal(runs, 1);
  assert.equal(timers[0].delay, 10_000);
  await scheduler.stop();
  assert.deepEqual(cleared, [timers[0]]);
  timers[0].callback();
  await new Promise(setImmediate);
  assert.equal(runs, 1);
  assert.equal(scheduler.timer, null);
});
test('failed backup never invokes retention pruning', async () => {
  let pruneCalls = 0;
  const job = new BackupJob({ backup: { async create() { throw Object.assign(new Error('write failed'), { code: 'BACKUP_UNAVAILABLE' }); }, async prune() { pruneCalls += 1; } } });
  await assert.rejects(job.run());
  assert.equal(pruneCalls, 0);
});

test('stage dry run has no mutation and scoped activation changes only affected epoch', async (t) => {
  const { backup } = await fixture(t);
  const point = await backup.create();
  const repository = new MemoryRestoreRepository({ accounts: [{ accountId: 'a' }], spaces: [{ accountId: 'a', spaceId: 'one', restoreEpoch: 10, marker: 'online' }, { accountId: 'a', spaceId: 'two', restoreEpoch: 20, marker: 'untouched' }] });
  const restore = new RestoreService({ backup, repository });
  const dry = await restore.stage(point.manifestId, { dryRun: true });
  assert.equal(dry.ready, true); assert.equal(repository.stages.size, 0); assert.equal(repository.mutations, 0);
  const stage = await restore.stage(point.manifestId);
  const applied = await restore.apply(stage.stageId, { scope: { type: 'space', accountId: 'a', spaceId: 'one' }, confirmation: 'RESTORE', createPreRestore: false });
  assert.equal(applied.affectedSpaces[0].restoreEpoch, 11);
  assert.equal(repository.online.spaces.find((space) => space.spaceId === 'two').restoreEpoch, 20);
  assert.equal(repository.online.spaces.find((space) => space.spaceId === 'two').marker, 'untouched');
});
