import { randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { verificationError } from '../backup/crypto.js';
import { RestoreService } from '../backup/restore.js';

const FORMAT = 'dynamic-panel-export-v1';
const MAX_PACKAGE_BYTES = 256 * 1024 * 1024;
const MAX_JSON_BYTES = 512 * 1024 * 1024;
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const MAX_FILES = 10000;
const MANIFEST_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const SAFE_KEYS = /^(?:manifest\.enc\.json|COMMITTED\.json|chunks\/[0-9]{6}\.json\.enc|objects\/[0-9]{6}\/[0-9]{6}\.bin\.enc)$/;

function invalid(reason) { throw verificationError(reason); }
function conflict(message = 'Import manifest already exists or is being imported') {
  return Object.assign(new Error(message), { code: 'IMPORT_CONFLICT' });
}
function safeBase64(value, limit = MAX_FILE_BYTES) {
  if (typeof value !== 'string' || !value || value.length > Math.ceil(limit / 3) * 4 + 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 === 1) invalid('invalid_package_base64');
  const body = Buffer.from(value, 'base64');
  if (body.length > limit || body.toString('base64') !== value) invalid('invalid_package_base64');
  return body;
}
function commitMarker(body, manifestId) {
  let value;
  try { value = JSON.parse(body.toString('utf8')); } catch (error) { throw verificationError('invalid_commit_marker', error); }
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.formatVersion !== 1 || value.manifestId !== manifestId || !/^[a-f0-9]{64}$/.test(value.manifestCipherSha256 ?? '')) invalid('invalid_commit_marker');
  return value;
}
function validatePackage(value, { maxDecodedBytes = MAX_PACKAGE_BYTES, maxFileBytes = MAX_FILE_BYTES } = {}) {
  if (!Number.isSafeInteger(maxDecodedBytes) || maxDecodedBytes < 1 || maxDecodedBytes > MAX_PACKAGE_BYTES || !Number.isSafeInteger(maxFileBytes) || maxFileBytes < 1 || maxFileBytes > MAX_FILE_BYTES) invalid('invalid_export_limit');
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.format !== FORMAT || typeof value.manifestId !== 'string' || !MANIFEST_ID.test(value.manifestId) || !Array.isArray(value.files) || value.files.length === 0 || value.files.length > MAX_FILES) invalid('invalid_export_package');
  const seen = new Set();
  let total = 0;
  const files = value.files.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) || typeof entry.key !== 'string' || !SAFE_KEYS.test(entry.key) || seen.has(entry.key)) invalid('invalid_package_key');
    seen.add(entry.key);
    const body = safeBase64(entry.body, maxFileBytes);
    total += body.length;
    if (total > maxDecodedBytes) invalid('export_package_too_large');
    return { key: entry.key, body };
  });
  if (!seen.has('manifest.enc.json') || !seen.has('COMMITTED.json')) invalid('invalid_export_package');
  commitMarker(files.find(({ key }) => key === 'COMMITTED.json').body, value.manifestId);
  return { manifestId: value.manifestId, files };
}

export async function readExportPackage(file, { maxBytes = MAX_JSON_BYTES, maxDecodedBytes = MAX_PACKAGE_BYTES, maxFileBytes = MAX_FILE_BYTES } = {}) {
  if (typeof file !== 'string' || !file) invalid('invalid_export_file');
  const info = await stat(file).catch((error) => { throw Object.assign(new Error('Export file is unavailable'), { code: 'IMPORT_FILE_UNAVAILABLE', cause: error }); });
  if (!info.isFile() || info.size > maxBytes || info.size > MAX_JSON_BYTES) invalid('export_package_too_large');
  let value;
  try { value = JSON.parse(await readFile(file, 'utf8')); } catch (error) { throw verificationError('invalid_export_package', error); }
  return validatePackage(value, { maxDecodedBytes, maxFileBytes });
}

export class ImportPackageService extends RestoreService {
  constructor({ backup, repository, target, id = randomUUID }) {
    super({ backup, repository });
    if (!target || typeof target.putExclusive !== 'function' || typeof target.moveExclusive !== 'function') throw new TypeError('backup target must support exclusive import publication');
    this.target = target; this.id = id;
  }

  async stageFile(file, { dryRun = false } = {}) {
    const pack = await readExportPackage(file);
    const attemptId = this.id();
    if (!MANIFEST_ID.test(attemptId)) throw new TypeError('import attempt ID is invalid');
    const prefix = `points/${pack.manifestId}`;
    const temporary = `temporary/import-${attemptId}`;
    const lease = `imports/${pack.manifestId}.lock`;
    const temporaryKeys = new Set();
    const publishedKeys = [];
    let committed = false;
    const leaseBody = Buffer.from(JSON.stringify({ manifestId: pack.manifestId, attemptId }));
    if (!await this.target.putExclusive(lease, leaseBody)) throw conflict();
    try {
      if ((await this.target.list(`${prefix}/`)).length !== 0) throw conflict('Import destination is not empty');
      for (const entry of pack.files) {
        const key = `${temporary}/${entry.key}`;
        temporaryKeys.add(key);
        await this.target.put(key, entry.body);
      }
      const marker = commitMarker(pack.files.find(({ key }) => key === 'COMMITTED.json').body, pack.manifestId);
      const verified = await this.backup.verifyAt(temporary, pack.manifestId, marker.manifestCipherSha256);
      if (dryRun) return await this.stageVerifiedPayload(pack.manifestId, verified, { dryRun: true });

      const publication = pack.files.filter(({ key }) => key !== 'COMMITTED.json');
      publication.push(pack.files.find(({ key }) => key === 'COMMITTED.json'));
      for (const entry of publication) {
        const source = `${temporary}/${entry.key}`;
        const destination = `${prefix}/${entry.key}`;
        if (!await this.target.moveExclusive(source, destination)) throw conflict('Import destination collided during publication');
        temporaryKeys.delete(source);
        publishedKeys.push(destination);
        if (entry.key === 'COMMITTED.json') committed = true;
      }
      return await this.stageVerifiedPayload(pack.manifestId, verified);
    } catch (error) {
      if (!committed) for (const key of publishedKeys.reverse()) await this.target.delete(key).catch(() => {});
      throw error;
    } finally {
      for (const key of temporaryKeys) await this.target.delete(key).catch(() => {});
      await this.target.delete(lease).catch(() => {});
    }
  }
}

export { FORMAT as EXPORT_PACKAGE_FORMAT, MAX_JSON_BYTES, MAX_PACKAGE_BYTES };
