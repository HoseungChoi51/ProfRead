/* global process, Buffer */
// Mount at /audit.mjs in an app image. Use only --production (read-only)
// against a read-only production volume; --baseline/--verify require a restored
// test volume mounted at /data. No provider credentials or production env file.
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const mode = process.argv[2];
assert(['--production', '--baseline', '--verify'].includes(mode));
const output = '/data/profread-migration-audit';
const quote = name => { assert(/^\w+$/.test(name)); return `"${name}"`; };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const tables = ['documents', 'document_versions', 'article_groups', 'document_tags', 'assets', 'blocks', 'anchors', 'highlights', 'threads', 'messages', 'model_runs', 'citations', 'artifacts', 'reading_progress', 'document_edit_revisions', 'import_jobs', 'import_findings'];
async function capture(path, prior) {
  const db = new DatabaseSync(path, { readOnly: true });
  db.exec('PRAGMA temp_store=MEMORY');
  const result = { schemaVersion: 0, integrity: [], foreignKeyErrors: 0, tables: {}, immutableFiles: [], sampleDocuments: [] };
  const files = new Set();
  try {
    db.exec('BEGIN');
    result.schemaVersion = db.prepare('SELECT MAX(version) version FROM migrations').get().version;
    result.integrity = db.prepare('PRAGMA integrity_check').all().map(value => Object.values(value)[0]);
    result.foreignKeyErrors = db.prepare('PRAGMA foreign_key_check').all().length;
    for (const table of tables) {
      if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) continue;
      const columns = prior?.tables[table]?.columns ?? db.prepare(`PRAGMA table_info(${quote(table)})`).all().map(column => column.name);
      const selected = columns.map(quote).join(',');
      const records = db.prepare(`SELECT ${selected} FROM ${quote(table)} ORDER BY ${selected}`).all();
      result.tables[table] = { columns, count: records.length, sha256: hash(Buffer.from(JSON.stringify(records))) };
    }
    for (const item of db.prepare('SELECT sanitized_html_path FROM document_versions WHERE sanitized_html_path IS NOT NULL').all()) files.add(item.sanitized_html_path);
    for (const item of db.prepare('SELECT storage_path FROM assets').all()) files.add(item.storage_path);
    result.sampleDocuments = db.prepare(`SELECT d.id,v.id versionId FROM documents d JOIN document_versions v ON v.document_id=d.id AND v.version=(SELECT MAX(version) FROM document_versions WHERE document_id=d.id) ORDER BY EXISTS(SELECT 1 FROM anchors a WHERE a.document_version_id=v.id) DESC,d.id LIMIT 3`).all();
    db.exec('COMMIT');
  } finally { db.close(); }
  for (const path of [...files]) if (/\.html?$/i.test(path)) {
    const source = join(dirname(path), 'source.pdf');
    try { await access(source); files.add(source); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  for (const path of [...files].sort()) {
    assert(resolve(path).startsWith('/data/'), 'Immutable source path escaped the isolated data directory.');
    const bytes = await readFile(path);
    result.immutableFiles.push({ path, bytes: bytes.length, sha256: hash(bytes) });
  }
  return result;
}
function compact(snapshot) { return { schemaVersion: snapshot.schemaVersion, integrity: snapshot.integrity, foreignKeyErrors: snapshot.foreignKeyErrors, counts: Object.fromEntries(Object.entries(snapshot.tables).map(([name, value]) => [name, value.count])), logicalHashes: Object.fromEntries(Object.entries(snapshot.tables).map(([name, value]) => [name, value.sha256])), immutableFiles: snapshot.immutableFiles.length, immutableBytes: snapshot.immutableFiles.reduce((total, item) => total + item.bytes, 0) }; }
if (mode !== '--verify') {
  const baseline = await capture('/data/afterdraft.sqlite');
  if (mode === '--baseline') {
    await mkdir(output, { recursive: true, mode: 0o700 });
    baseline.legacyDatabaseHash = hash(await readFile('/data/afterdraft.sqlite'));
    await writeFile(`${output}/baseline.json`, JSON.stringify(baseline, null, 2), { mode: 0o600 });
  }
  process.stdout.write(JSON.stringify({ mode, ...compact(baseline) }, null, 2) + '\n');
} else {
  const baseline = JSON.parse(await readFile(`${output}/baseline.json`, 'utf8'));
  assert.equal(baseline.schemaVersion, 19, 'Expected the accepted migration19 backup.');
  assert.deepEqual(baseline.integrity, ['ok']); assert.equal(baseline.foreignKeyErrors, 0);
  const password = randomBytes(24).toString('hex');
  Object.assign(process.env, { NODE_ENV: 'test', PROFREAD_DATA_DIR: '/data', PROFREAD_BACKGROUND_JOBS: 'disabled', PROFREAD_PASSWORD: password, PROFREAD_SESSION_SECRET: randomBytes(32).toString('hex'), ACADEMIC_WORKER_URL: 'http://127.0.0.1:1' });
  for (const key of Object.keys(process.env)) if (/API_KEY|^AFTERDRAFT_PASSWORD$|^AFTERDRAFT_SESSION_SECRET$/.test(key)) delete process.env[key];
  const { db } = await import('file:///app/apps/server/dist/db/index.js');
  const migrated = await capture('/data/profread.sqlite', baseline);
  assert.equal(migrated.schemaVersion, 20); assert.deepEqual(migrated.integrity, ['ok']); assert.equal(migrated.foreignKeyErrors, 0);
  for (const [name, original] of Object.entries(baseline.tables)) assert.deepEqual(migrated.tables[name], original, `Legacy table ${name} changed`);
  assert.deepEqual(migrated.immutableFiles, baseline.immutableFiles, 'Original HTML or assets changed');
  assert.equal(hash(await readFile('/data/afterdraft.sqlite')), baseline.legacyDatabaseHash, 'Legacy database bytes changed');
  assert.equal(db.prepare("SELECT COUNT(*) count FROM document_representations WHERE kind='html'").get().count, baseline.tables.document_versions.count);
  assert.equal(db.prepare("SELECT COUNT(*) count FROM anchors WHERE representation_id IS NULL OR representation_id!='html-'||document_version_id").get().count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) count FROM source_citations').get().count, 0);
  const { buildApp } = await import('file:///app/apps/server/dist/app.js');
  const { exportHtmlLibrary } = await import('file:///app/apps/server/dist/exports/library.js');
  const app = await buildApp(); app.log.level = 'error';
  let exports, sampledAssets = 0;
  try {
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { password } }); assert.equal(login.statusCode, 200);
    const headers = { cookie: login.cookies.map(item => `${item.name}=${item.value}`).join('; '), 'x-csrf-token': login.cookies.find(item => item.name === 'profread_csrf').value };
    for (const document of baseline.sampleDocuments) {
      const detail = await app.inject({ method: 'GET', url: `/api/documents/${document.id}`, headers }); assert.equal(detail.statusCode, 200); assert(detail.json().representations.some(item => item.kind === 'html'));
      const html = await app.inject({ method: 'GET', url: `/api/versions/${document.versionId}/content`, headers }); assert.equal(html.statusCode, 200); assert(html.body.includes('<html'));
      const highlights = await app.inject({ method: 'GET', url: `/api/documents/${document.id}/highlights`, headers }); assert.equal(highlights.statusCode, 200);
      for (const item of highlights.json()) if (item.status === 'attached') assert(html.body.includes(item.block_id), 'A saved highlight no longer points to a served source block.');
      const threads = await app.inject({ method: 'GET', url: `/api/documents/${document.id}/threads`, headers }); assert.equal(threads.statusCode, 200);
      for (const asset of db.prepare('SELECT id,content_hash FROM assets WHERE document_version_id=? ORDER BY id LIMIT 3').all(document.versionId)) {
        const served = await app.inject({ method: 'GET', url: `/api/assets/${document.versionId}/${asset.id}`, headers }); assert.equal(served.statusCode, 200); assert.equal(hash(served.rawPayload), asset.content_hash); sampledAssets++;
      }
      for (const format of ['html', 'markdown']) {
        const exported = await app.inject({ method: 'POST', url: `/api/documents/${document.id}/exports`, headers, payload: { format } }); assert.equal(exported.statusCode, 200); assert(exported.rawPayload.length > 100);
      }
    }
    exports = await exportHtmlLibrary(`${output}/library`);
    assert.equal(exports.count, baseline.tables.documents.count);
    const manifest = JSON.parse(await readFile(exports.manifestPath, 'utf8'));
    for (const document of manifest.documents) for (const file of document.files) await access(`${output}/library/${file.filename}`);
    assert.equal(db.prepare('SELECT COUNT(*) count FROM model_runs').get().count, baseline.tables.model_runs.count);
    assert.equal(db.prepare('SELECT COUNT(*) count FROM citations').get().count, baseline.tables.citations.count);
    assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
  } finally { await app.close(); }
  const report = { status: 'passed', migrated: compact(migrated), legacyDatabaseUnchanged: true, immutableFilesUnchanged: true, legacyRowsUnchanged: true, sourceCitationsPreserved: baseline.tables.citations.count, savedAnchorsPreserved: baseline.tables.anchors.count, artifactSourceRefsPreserved: baseline.tables.artifacts.count, sampledHtmlDocuments: baseline.sampleDocuments.length, sampledAssets, libraryExports: exports.count, modelCalls: 0 };
  await writeFile(`${output}/result.json`, JSON.stringify(report, null, 2), { mode: 0o600 });
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
}
