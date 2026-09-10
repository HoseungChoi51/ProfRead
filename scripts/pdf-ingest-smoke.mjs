// Run with: node --import tsx scripts/pdf-ingest-smoke.mjs SOURCE.pdf WORKER_URL
/* global process, URL, fetch, setTimeout, FormData, Blob, Buffer */
// Use an isolated local worker (Docker --internal network), never production.
// All app data and the evidence image remain in a new /tmp/profread-pdf-smoke-* directory.
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const [sourcePath, workerUrl] = process.argv.slice(2);
assert(sourcePath && workerUrl, 'Pass the Spectrum PDF path and an isolated local worker URL.');
const workerHost = new URL(workerUrl).hostname;
assert(/^(127\.0\.0\.1|localhost|10\.\d+\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|192\.168\.\d+\.\d+)$/.test(workerHost), 'Use a local/private isolated worker address.');
const directory = await mkdtemp('/tmp/profread-pdf-smoke-');
const password = randomBytes(24).toString('hex');
Object.assign(process.env, {
  PROFREAD_DATA_DIR: directory,
  PROFREAD_PASSWORD: password,
  PROFREAD_SESSION_SECRET: randomBytes(32).toString('hex'),
  PROFREAD_WEB_DIR: join(directory, 'no-web-build'),
  PROFREAD_BACKGROUND_JOBS: 'enabled',
  ACADEMIC_WORKER_URL: workerUrl,
  NODE_ENV: 'test',
});
// The smoke never runs a model. Ensure accidental inherited provider credentials
// are unavailable to the isolated app process as an additional guard.
for (const key of Object.keys(process.env)) if (/^(OPENAI|OPENROUTER|ANTHROPIC|GEMINI|GOOGLE|DEEPSEEK|GROQ|MISTRAL).*API_KEY$/.test(key)) delete process.env[key];
const { buildApp } = await import('../apps/server/src/app.ts');
const { row } = await import('../apps/server/src/db/index.ts');
const { representation } = await import('../apps/server/src/pdf/repository.ts');
const { buildPdfContext } = await import('../apps/server/src/pdf/context.ts');
const { buildPdfEvidence } = await import('../apps/server/src/pdf/evidence.ts');
const app = await buildApp();
app.log.level = 'error';
const address = await app.listen({ host: '127.0.0.1', port: 0 });
const start = Date.now();
const report = (phase, data = {}) => process.stdout.write(JSON.stringify({ phase, elapsedMs: Date.now() - start, ...data }) + '\n');
let auth = {};
async function request(path, options = {}) {
  const response = await fetch(address + path, { ...options, headers: { ...auth, ...options.headers } });
  assert(response.ok, `${path}: HTTP ${response.status} ${await response.clone().text()}`);
  return response;
}
async function json(path, options) { return (await request(path, options)).json(); }
async function until(read, accept, label, timeout = 300_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await read();
    if (['failed', 'cancelled'].includes(value.status)) throw new Error(`${label}: ${value.error ?? value.status}`);
    if (accept(value)) return value;
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  throw new Error(`Timed out: ${label}`);
}
try {
  const health = await (await fetch(workerUrl + '/health')).json();
  assert.equal(health.status, 'ok');
  assert(health.ocrLanguages.includes('eng') && health.ocrLanguages.includes('kor'));
  const login = await request('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password }) });
  const cookies = login.headers.getSetCookie().map(cookie => cookie.split(';')[0]);
  auth = { cookie: cookies.join('; '), 'x-csrf-token': cookies.find(cookie => cookie.startsWith('profread_csrf=')).slice('profread_csrf='.length) };
  const original = await readFile(sourcePath), originalHash = createHash('sha256').update(original).digest('hex');
  const form = new FormData();
  form.set('sourceKind', 'pdf'); form.set('readingFormat', 'pdf'); form.set('ocrLanguage', 'eng');
  form.set('aiReview', JSON.stringify({ enabled: false }));
  form.set('articleSelection', JSON.stringify({ title: 'What it means to be a mathematician when AI does the math', aiBoundary: false }));
  form.set('file', new Blob([original], { type: 'application/pdf' }), 'spectrum-smoke.pdf');
  const created = await json('/api/import-jobs', { method: 'POST', body: form });
  report('uploaded', { jobId: created.jobId, directory });
  await until(() => json(`/api/import-jobs/${created.jobId}`), job => job.status === 'awaiting-selection', 'magazine inspection');
  report('awaiting-user-confirmation');
  await json(`/api/import-jobs/${created.jobId}/article-selection`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ startPage: 22, endPage: 28 }) });
  const published = await until(() => json(`/api/import-jobs/${created.jobId}`), job => job.status === 'published', 'PDF publication');
  const job = row('SELECT * FROM import_jobs WHERE id=?', created.jobId);
  const stored = row("SELECT id FROM document_representations WHERE document_version_id=? AND kind='pdf'", job.document_version_id);
  const id = stored.id;
  const initial = await json(`/api/representations/${id}/manifest`);
  assert.deepEqual(initial.pages.map(page => page.sourcePage), [22, 23, 24, 25, 26, 27, 28]);
  assert.equal(initial.sourceHash, originalHash);
  assert.deepEqual({ ...row('SELECT entry_path,sanitized_html_path FROM document_versions WHERE id=?', job.document_version_id) }, { entry_path: null, sanitized_html_path: null });
  report('published-before-index-completion', { documentId: job.document_id, representationId: id, status: initial.status, pages: initial.pages.map(page => ({ sourcePage: page.sourcePage, status: page.textStatus })) });
  const indexed = await until(() => json(`/api/representations/${id}/manifest`), manifest => ['ready', 'partial'].includes(manifest.status), 'native/OCR indexing');
  assert.equal(indexed.status, 'ready', JSON.stringify(indexed.pages.map(page => ({ page: page.sourcePage, error: page.error }))));
  assert.equal(indexed.pages.length, 7);
  assert.equal(indexed.pages[1].sourcePage, 23);
  assert.equal(indexed.pages[0].textStatus, 'ocr');
  assert(indexed.pages.some(page => /mathematician/i.test(page.text)));
  const source = representation(id);
  assert.equal(createHash('sha256').update(await readFile(source.source_path)).digest('hex'), originalHash);
  const derivative = await readFile(source.pdf_path);
  assert.equal(createHash('sha256').update(derivative).digest('hex'), indexed.pdfHash);
  const selector = { kind: 'pdf-region', representationId: id, sourceHash: originalHash, extractionRevision: indexed.extractionRevision, exact: '', segments: [{ page: 2, quads: [[40, 650, 520, 650, 520, 100, 40, 100]] }] };
  const anchor = await json('/api/anchors', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ documentVersionId: job.document_version_id, selector }) });
  const snapshot = buildPdfContext({ documentVersionId: job.document_version_id, representationId: id, profile: 'deep', query: 'What does this illustration show?', anchorId: anchor.id, allowPartial: true });
  const evidence = await buildPdfEvidence(snapshot, { maxImages: 1 });
  assert.equal(evidence.images.length, 1);
  await writeFile(join(directory, 'page-23-anchor.png'), Buffer.from(evidence.images[0].data, 'base64'));
  const staging = join(directory, 'imports', created.jobId);
  assert(!source.source_path.startsWith(staging));
  await rm(staging, { recursive: true });
  const bytes = await request(`/api/representations/${id}/pdf`, { headers: { range: 'bytes=0-7' } });
  assert.equal(bytes.status, 206); assert.deepEqual(Buffer.from(await bytes.arrayBuffer()), derivative.subarray(0, 8));
  assert.equal(createHash('sha256').update(await readFile(sourcePath)).digest('hex'), originalHash);
  assert.equal(row('SELECT COUNT(*) count FROM model_runs').count, 0);
  const result = { status: 'passed', directory, documentId: published.documentId ?? job.document_id, representationId: id, originalBytes: original.length, derivativeBytes: derivative.length, pages: indexed.pages.map(page => ({ page: page.page, sourcePage: page.sourcePage, status: page.textStatus, characters: page.text.length, confidence: page.confidence })), evidenceImages: evidence.images.length, modelRuns: 0 };
  await writeFile(join(directory, 'smoke-result.json'), JSON.stringify(result, null, 2));
  report('complete', result);
} finally { await app.close(); }
