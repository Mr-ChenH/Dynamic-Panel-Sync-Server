import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { BackupService } from '../src/backup/service.js';
import { MemoryRestoreRepository } from '../src/backup/memory-repository.js';
import { FilesystemBackupTarget, S3BackupTarget } from '../src/backup/targets.js';
import { ImportPackageService, readExportPackage } from '../src/cli/import-package.js';

async function packageFixture(t) {
  const sourceRoot = await mkdtemp(path.join(tmpdir(), 'dp-import-source-'));
  const importRoot = await mkdtemp(path.join(tmpdir(), 'dp-import-target-'));
  t.after(() => Promise.all([rm(sourceRoot, { recursive: true, force: true }), rm(importRoot, { recursive: true, force: true })]));
  const sourceTarget = new FilesystemBackupTarget(sourceRoot);
  const target = new FilesystemBackupTarget(importRoot);
  const source = { async snapshot() { return { databaseSchema: 1, data: { accounts: [], spaces: [], records: [{ value: 'portable' }] }, objectEntries: [] }; } };
  const masterKey = randomBytes(32);
  const sourceBackup = new BackupService({ source, target: sourceTarget, masterKey, keyId: 'import-key', id: () => 'portable-point', chunkBytes: 8 });
  const point = await sourceBackup.create();
  const files = await Promise.all((await sourceTarget.list(`points/${point.manifestId}/`)).map(async (key) => ({
    key: key.slice(`points/${point.manifestId}/`.length),
    body: (await sourceTarget.get(key)).toString('base64')
  })));
  const packageFile = path.join(sourceRoot, 'export.json');
  await writeFile(packageFile, JSON.stringify({ format: 'dynamic-panel-export-v1', manifestId: point.manifestId, files }));
  const backup = new BackupService({ source, target, masterKey, keyId: 'import-key' });
  const repository = new MemoryRestoreRepository();
  return { backup, files, packageFile, repository, target };
}

function importer(fixture, id) {
  return new ImportPackageService({ ...fixture, id: () => id });
}

test('import verifies privately and publishes COMMITTED.json strictly last', async (t) => {
  const fixture = await packageFixture(t);
  const events = [];
  const verifyAt = fixture.backup.verifyAt.bind(fixture.backup);
  fixture.backup.verifyAt = async (...args) => { events.push(['verify', args[0]]); return verifyAt(...args); };
  const moveExclusive = fixture.target.moveExclusive.bind(fixture.target);
  fixture.target.moveExclusive = async (from, to) => { events.push(['publish', to]); return moveExclusive(from, to); };
  const result = await importer(fixture, 'attempt-order').stageFile(fixture.packageFile);
  assert.equal(result.ready, true);
  assert.equal(events[0][0], 'verify');
  assert.match(events[0][1], /^temporary\/import-attempt-order$/);
  assert.equal(events.filter(([kind]) => kind === 'publish').at(-1)[1], 'points/portable-point/COMMITTED.json');
});

test('file import dry-run verifies compatibility without persistent target, stage, or online mutation', async (t) => {
  const fixture = await packageFixture(t);
  fixture.repository.online = { accounts: [{ accountId: 'online' }], spaces: [{ accountId: 'online', spaceId: 'live', restoreEpoch: 7 }] };
  const onlineBefore = structuredClone(fixture.repository.online);
  let publications = 0;
  const moveExclusive = fixture.target.moveExclusive.bind(fixture.target);
  fixture.target.moveExclusive = async (...args) => { publications += 1; return moveExclusive(...args); };

  const result = await importer(fixture, 'attempt-dry-run').stageFile(fixture.packageFile, { dryRun: true });

  assert.equal(result.ready, true);
  assert.equal(result.dryRun, true);
  assert.equal(result.stageId, null);
  assert.equal(publications, 0);
  assert.deepEqual(await fixture.target.list(), []);
  assert.equal(fixture.repository.stages.size, 0);
  assert.equal(fixture.repository.mutations, 0);
  assert.deepEqual(fixture.repository.online, onlineBefore);
});

test('failure after marker publication retains a verified point recoverable by manifest ID', async (t) => {
  const fixture = await packageFixture(t);
  fixture.repository.saveStage = async () => { throw Object.assign(new Error('injected stage failure'), { code: 'INJECTED_STAGE_FAILURE' }); };

  await assert.rejects(importer(fixture, 'attempt-post-marker').stageFile(fixture.packageFile), (error) => error.code === 'INJECTED_STAGE_FAILURE');

  assert.equal(await fixture.target.exists('points/portable-point/COMMITTED.json'), true);
  assert.equal(await fixture.target.exists('imports/portable-point.lock'), false);
  assert.deepEqual(await fixture.target.list('temporary/import-attempt-post-marker/'), []);
  assert.equal((await fixture.backup.verify('portable-point')).status, 'verified');
  assert.equal(fixture.repository.stages.size, 0);

  const recoveryRepository = new MemoryRestoreRepository();
  const recovered = await importer({ ...fixture, repository: recoveryRepository }, 'recovered-stage').stage('portable-point');
  assert.equal(recovered.ready, true);
  assert.equal(recovered.stageId, 'recovered-stage');
  assert.equal(recoveryRepository.stages.size, 1);
});

test('simulated crash residue is uncommitted, blocks retry, and is never deleted by another import', async (t) => {
  const fixture = await packageFixture(t);
  const lease = 'imports/portable-point.lock';
  assert.equal(await fixture.target.putExclusive(lease, Buffer.from('crashed-attempt')), true);
  const payload = fixture.files.find(({ key }) => key !== 'COMMITTED.json');
  const partialKey = `points/portable-point/${payload.key}`;
  await fixture.target.put(partialKey, Buffer.from('crash-residue'));
  await assert.rejects(importer(fixture, 'attempt-retry').stageFile(fixture.packageFile), (error) => error.code === 'IMPORT_CONFLICT');
  assert.deepEqual(await fixture.target.get(partialKey), Buffer.from('crash-residue'));
  assert.equal(await fixture.target.exists('points/portable-point/COMMITTED.json'), false);
  assert.equal(await fixture.target.exists(lease), true);
});

test('destination collision is preserved and a concurrent importer loses the manifest lease', async (t) => {
  const collisionFixture = await packageFixture(t);
  const existing = 'points/portable-point/chunks/999999.json.enc';
  await collisionFixture.target.put(existing, Buffer.from('pre-existing'));
  await assert.rejects(importer(collisionFixture, 'attempt-collision').stageFile(collisionFixture.packageFile), (error) => error.code === 'IMPORT_CONFLICT');
  assert.deepEqual(await collisionFixture.target.get(existing), Buffer.from('pre-existing'));

  const fixture = await packageFixture(t);
  const originalPut = fixture.target.put.bind(fixture.target);
  let unblock;
  const blocked = new Promise((resolve) => { unblock = resolve; });
  let started;
  const writing = new Promise((resolve) => { started = resolve; });
  let paused = false;
  fixture.target.put = async (key, body) => {
    if (!paused && key.startsWith('temporary/import-attempt-first/')) { paused = true; started(); await blocked; }
    return originalPut(key, body);
  };
  const first = importer(fixture, 'attempt-first').stageFile(fixture.packageFile);
  await writing;
  await assert.rejects(importer(fixture, 'attempt-second').stageFile(fixture.packageFile), (error) => error.code === 'IMPORT_CONFLICT');
  unblock();
  assert.equal((await first).ready, true);
});

test('normal mid-publication failure cleans only keys owned by that attempt', async (t) => {
  const fixture = await packageFixture(t);
  await fixture.target.put('points/unrelated/COMMITTED.json', Buffer.from('keep'));
  const moveExclusive = fixture.target.moveExclusive.bind(fixture.target);
  let moves = 0;
  fixture.target.moveExclusive = async (from, to) => {
    moves += 1;
    if (moves === 2) throw Object.assign(new Error('injected publication failure'), { code: 'INJECTED_FAILURE' });
    return moveExclusive(from, to);
  };
  await assert.rejects(importer(fixture, 'attempt-failure').stageFile(fixture.packageFile), (error) => error.code === 'INJECTED_FAILURE');
  assert.deepEqual(await fixture.target.list('points/portable-point/'), []);
  assert.deepEqual(await fixture.target.get('points/unrelated/COMMITTED.json'), Buffer.from('keep'));
  assert.deepEqual(await fixture.target.list('temporary/import-attempt-failure/'), []);
  assert.equal(await fixture.target.exists('imports/portable-point.lock'), false);
});

test('package reader applies encoded JSON and decoded payload limits independently', async (t) => {
  const fixture = await packageFixture(t);
  const encodedBytes = Buffer.byteLength(await readFile(fixture.packageFile));
  await assert.rejects(readExportPackage(fixture.packageFile, { maxBytes: encodedBytes - 1 }), (error) => error.reason === 'export_package_too_large');
  await assert.rejects(readExportPackage(fixture.packageFile, { maxDecodedBytes: 8, maxFileBytes: 64 * 1024 * 1024 }), (error) => error.reason === 'export_package_too_large' || error.reason === 'invalid_package_base64');
  const malformed = path.join(path.dirname(fixture.packageFile), 'malformed.json');
  const value = JSON.parse(await readFile(fixture.packageFile, 'utf8'));
  value.files[0].body = 'YQ=';
  await writeFile(malformed, JSON.stringify(value));
  await assert.rejects(readExportPackage(malformed), (error) => error.reason === 'invalid_package_base64');
});

test('S3 target uses conditional writes and keeps the source on publication collision', async () => {
  const objects = new Map([['root/destination.bin', Buffer.from('existing')], ['root/source.bin', Buffer.from('source')]]);
  const puts = [];
  const client = {
    async putObject(input) {
      puts.push(input);
      if (input.IfNoneMatch === '*' && objects.has(input.Key)) throw Object.assign(new Error('exists'), { name: 'PreconditionFailed', $metadata: { httpStatusCode: 412 } });
      objects.set(input.Key, Buffer.from(input.Body));
    },
    async getObject({ Key }) { return { Body: objects.get(Key) }; },
    async deleteObject({ Key }) { objects.delete(Key); }
  };
  const target = new S3BackupTarget({ client, bucket: 'backups', prefix: 'root' });
  assert.equal(await target.putExclusive('lease.lock', Buffer.from('one')), true);
  assert.equal(await target.putExclusive('lease.lock', Buffer.from('two')), false);
  assert.equal(await target.moveExclusive('source.bin', 'destination.bin'), false);
  assert.deepEqual(objects.get('root/source.bin'), Buffer.from('source'));
  assert.deepEqual(objects.get('root/destination.bin'), Buffer.from('existing'));
  assert.ok(puts.every((input) => input.IfNoneMatch === '*'));
});
