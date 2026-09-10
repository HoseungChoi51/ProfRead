#!/usr/bin/env node
/* global fetch, AbortSignal */
import {Buffer} from 'node:buffer';
import console from 'node:console';
import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {readFile, realpath, stat, writeFile} from 'node:fs/promises';
import {join, resolve, sep} from 'node:path';
import process from 'node:process';
import {DatabaseSync} from 'node:sqlite';
import {setTimeout as delay} from 'node:timers/promises';
import {URL, URLSearchParams} from 'node:url';

// Standalone release acceptance: mount this file into the running app container.
// Credentials come only from its existing environment and are never logged.
// --verify issues GETs plus login/logout only. In particular, it intentionally
// avoids GET /api/documents/:id, which can start legacy AI context generation.
// --enable-spectrum-pdf adds exactly the retained-source PDF representation/job.
const usage = 'node profread-acceptance.mjs (--verify | --enable-spectrum-pdf) [--expected-source-sha256 HEX] [--baseline FILE] [--save-baseline FILE] [--origin http://127.0.0.1:4310]';
class AcceptanceFailure extends Error {
  constructor(check, httpStatus) {super(check); this.check = check; this.httpStatus = httpStatus;}
}
function requireCheck(condition, check, status) {if (!condition) throw new AcceptanceFailure(check, status);}
function parseArguments() {
  const values = process.argv.slice(2), options = {};
  for (let index = 0; index < values.length; index++) {
    const value = values[index];
    if (value === '--help') return {help: true};
    if (value === '--verify' || value === '--enable-spectrum-pdf') {requireCheck(!options.mode, 'one_mode_required'); options.mode = value.slice(2); continue;}
    const keys = {'--expected-source-sha256': 'expectedHash', '--baseline': 'baselinePath', '--save-baseline': 'saveBaselinePath', '--origin': 'origin'};
    const key = keys[value]; requireCheck(key && values[index + 1] && !values[index + 1].startsWith('--') && !options[key], 'invalid_arguments');
    options[key] = values[++index];
  }
  requireCheck(options.mode, 'one_mode_required');
  if (options.expectedHash) requireCheck(/^[a-f0-9]{64}$/i.test(options.expectedHash), 'invalid_expected_source_hash');
  return options;
}
const digest = value => createHash('sha256').update(value).digest('hex');
const normalizeTitle = value => value.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const desiredTitle = normalizeTitle('What it means to be a mathematician when AI does the math');
const emit = value => console.log(JSON.stringify(value));
let db, cookie = '', csrf = '', origin, options, finalResult;

async function request(path, {method = 'GET', body, authenticated = true, headers = {}, timeoutMs = 30000} = {}) {
  let response;
  try {
    response = await fetch(new URL(path, origin), {method, redirect: 'error', signal: AbortSignal.timeout(Math.min(30000, Math.max(1, timeoutMs))), headers: {...(authenticated ? {cookie} : {}), ...(body !== undefined ? {'content-type': 'application/json', 'x-csrf-token': csrf} : {}), ...headers}, ...(body !== undefined ? {body: JSON.stringify(body)} : {})});
  } catch {throw new AcceptanceFailure('http_transport_failed');}
  return response;
}
async function json(path, options) {
  const response = await request(path, options);
  requireCheck(response.ok, 'api_request_failed', response.status);
  try {return await response.json();} catch {throw new AcceptanceFailure('invalid_api_json', response.status);}
}
function cookieParts(header) {
  const parts = header.split(';').map(value => value.trim()), equals = parts[0].indexOf('=');
  return {name: parts[0].slice(0, equals), value: parts[0].slice(equals + 1), attributes: new Map(parts.slice(1).map(value => {const at = value.indexOf('='); return at < 0 ? [value.toLowerCase(), true] : [value.slice(0, at).toLowerCase(), value.slice(at + 1)];}))};
}
async function login() {
  const password = process.env.PROFREAD_PASSWORD;
  requireCheck(Boolean(password), 'profread_password_environment_missing');
  const denied = await request('/api/documents', {authenticated: false});
  requireCheck(denied.status === 401, 'unauthenticated_library_must_be_denied', denied.status);
  await denied.body?.cancel();
  const response = await request('/api/auth/login', {method: 'POST', body: {password}, authenticated: false});
  requireCheck(response.status === 200, 'login_failed', response.status);
  const cookies = response.headers.getSetCookie().map(cookieParts);
  const session = cookies.find(value => value.name === 'profread_session'), token = cookies.find(value => value.name === 'profread_csrf');
  requireCheck(session?.value && token?.value, 'canonical_auth_cookies_missing');
  for (const value of [session, token]) {
    requireCheck(value.attributes.get('path') === '/' && String(value.attributes.get('samesite')).toLowerCase() === 'strict' && Number(value.attributes.get('max-age')) > 0, 'cookie_scope_attributes_invalid');
    if (process.env.NODE_ENV === 'production') requireCheck(value.attributes.has('secure'), 'production_cookie_not_secure');
  }
  requireCheck(session.attributes.has('httponly') && !token.attributes.has('httponly'), 'cookie_httponly_attributes_invalid');
  cookie = `${session.name}=${session.value}; ${token.name}=${token.value}`; csrf = token.value;
  await response.body?.cancel();
  const sessionResponse = await json('/api/auth/session');
  requireCheck(sessionResponse.authenticated === true, 'authenticated_session_missing');
}
function rows(sql, ...parameters) {return db.prepare(sql).all(...parameters);}
function row(sql, ...parameters) {return db.prepare(sql).get(...parameters);}
function tableFingerprint(sql) {const values = rows(sql); return {count: values.length, sha256: digest(JSON.stringify(values))};}
async function fileFingerprint(path, dataRoot) {
  let resolved, information;
  try {resolved = await realpath(path); information = await stat(resolved);} catch {throw new AcceptanceFailure('retained_file_missing');}
  requireCheck(resolved.startsWith(dataRoot + sep) && information.isFile(), 'retained_file_outside_data_root');
  const hash = createHash('sha256'); let bytes = 0;
  try {for await (const chunk of createReadStream(resolved)) {bytes += chunk.length; hash.update(chunk);}} catch {throw new AcceptanceFailure('retained_file_unreadable');}
  return {bytes, sha256: hash.digest('hex')};
}
async function snapshot(dataRoot) {
  const tables = {
    documents: 'SELECT id,title,group_id,created_at FROM documents ORDER BY id',
    versions: 'SELECT id,document_id,content_hash,source_name,entry_path,sanitized_html_path,version,created_at FROM document_versions ORDER BY id',
    anchors: 'SELECT * FROM anchors ORDER BY id', highlights: 'SELECT * FROM highlights ORDER BY id',
    threads: 'SELECT * FROM threads ORDER BY id', messages: 'SELECT * FROM messages ORDER BY id',
    artifacts: 'SELECT * FROM artifacts ORDER BY id', edits: 'SELECT * FROM document_edit_revisions ORDER BY id',
    modelRuns: 'SELECT * FROM model_runs ORDER BY id',
  };
  const fingerprints = Object.fromEntries(Object.entries(tables).map(([name, sql]) => [name, tableFingerprint(sql)]));
  const htmlFiles = [];
  for (const item of rows("SELECT 'version:'||id id,sanitized_html_path path FROM document_versions WHERE sanitized_html_path IS NOT NULL UNION ALL SELECT 'edit:'||id,edited_html_path FROM document_edit_revisions ORDER BY id")) {
    const file = await fileFingerprint(item.path, dataRoot); requireCheck(file.bytes > 0, 'empty_retained_html'); htmlFiles.push({id: item.id, ...file});
  }
  return {format: 1, fingerprints, htmlFiles};
}
function compareBaseline(baseline, current) {
  requireCheck(baseline?.format === 1 && baseline.fingerprints && Array.isArray(baseline.htmlFiles), 'invalid_baseline');
  for (const [name, value] of Object.entries(baseline.fingerprints)) requireCheck(JSON.stringify(value) === JSON.stringify(current.fingerprints[name]), `preservation_failed_${name}`);
  requireCheck(JSON.stringify(baseline.htmlFiles) === JSON.stringify(current.htmlFiles), 'preservation_failed_html_bytes');
}
async function verifyLibrary() {
  const documents = rows('SELECT d.id,d.title,v.id version_id,v.sanitized_html_path FROM documents d JOIN document_versions v ON v.document_id=d.id AND v.version=(SELECT MAX(version) FROM document_versions WHERE document_id=d.id) ORDER BY d.id');
  const apiDocuments = await json('/api/documents');
  requireCheck(Array.isArray(apiDocuments) && JSON.stringify(apiDocuments.map(item => item.id).sort()) === JSON.stringify(documents.map(item => item.id).sort()), 'library_document_ids_mismatch');
  const candidates = documents.filter(document => normalizeTitle(document.title).includes(desiredTitle));
  requireCheck(candidates.length === 1, candidates.length ? 'spectrum_title_ambiguous' : 'spectrum_title_not_found');
  let htmlViews = 0, pdfViews = 0, visibleHighlights = 0, visibleThreads = 0;
  for (const document of documents) {
    const versions = await json(`/api/documents/${document.id}/versions`);
    requireCheck(Array.isArray(versions) && versions.some(version => version.id === document.version_id), 'document_version_api_mismatch');
    const representations = rows('SELECT r.* FROM document_representations r JOIN document_versions v ON v.id=r.document_version_id WHERE v.document_id=?', document.id);
    if (document.sanitized_html_path) {
      requireCheck(representations.some(source => source.document_version_id === document.version_id && source.kind === 'html'), 'html_representation_missing');
      const content = await request(`/api/versions/${document.version_id}/content`);
      requireCheck(content.status === 200 && /text\/html/i.test(content.headers.get('content-type') ?? ''), 'html_content_unavailable', content.status);
      const body = await content.text(); requireCheck(body.length > 100 && /<html(?:\s|>)/i.test(body), 'html_content_invalid'); htmlViews++;
    }
    const highlights = await json(`/api/documents/${document.id}/highlights`), threads = await json(`/api/documents/${document.id}/threads`);
    const expectedHighlights = rows('SELECT h.id FROM highlights h JOIN anchors a ON a.id=h.anchor_id JOIN document_versions v ON v.id=a.document_version_id WHERE v.document_id=? AND (a.selector_json IS NOT NULL OR v.id=?) ORDER BY h.id', document.id, document.version_id);
    const expectedThreads = rows('SELECT id FROM threads WHERE document_id=? ORDER BY id', document.id);
    requireCheck(Array.isArray(highlights) && JSON.stringify(highlights.map(item => item.id).sort()) === JSON.stringify(expectedHighlights.map(item => item.id)), 'highlight_api_mismatch');
    requireCheck(Array.isArray(threads) && JSON.stringify(threads.map(item => item.id).sort()) === JSON.stringify(expectedThreads.map(item => item.id)), 'thread_api_mismatch');
    for (const thread of threads) {
      let messages; try {messages = typeof thread.messages === 'string' ? JSON.parse(thread.messages) : thread.messages;} catch {throw new AcceptanceFailure('thread_messages_invalid');}
      requireCheck(Array.isArray(messages) && JSON.stringify(messages.map(message => message.id).sort()) === JSON.stringify(rows('SELECT id FROM messages WHERE thread_id=? ORDER BY id', thread.id).map(message => message.id)), 'thread_message_api_mismatch');
    }
    visibleHighlights += highlights.length; visibleThreads += threads.length;
    const indexed = row("SELECT title,body FROM search_index WHERE document_id=? AND kind='article' LIMIT 1", document.id);
    const query = `${indexed?.title ?? ''} ${indexed?.body ?? ''}`.match(/[\p{L}\p{N}]{3,}/u)?.[0];
    requireCheck(query, 'article_search_probe_missing');
    const hits = await json('/api/search?' + new URLSearchParams({q: `"${query}"`, document: document.id, type: 'article'}));
    requireCheck(Array.isArray(hits) && hits.some(hit => hit.document_id === document.id), 'article_search_no_hits');
    for (const representation of representations.filter(source => source.kind === 'pdf')) {
      const manifest = await json(`/api/representations/${representation.id}/manifest`);
      requireCheck(manifest.representationId === representation.id && manifest.pages.length === representation.page_count && manifest.sourceHash === representation.source_hash && manifest.pdfHash === representation.pdf_hash, 'pdf_manifest_mismatch');
      pdfViews++;
    }
  }
  return {documents, spectrum: candidates[0], counts: {documents: documents.length, htmlViews, pdfViews, visibleHighlights, visibleThreads}};
}
async function enableSpectrumPdf(spectrum) {
  const existing = row("SELECT id FROM document_representations WHERE document_version_id=? AND kind='pdf'", spectrum.version_id);
  requireCheck(Boolean(spectrum.sanitized_html_path || existing), 'existing_spectrum_html_required');
  const started = Date.now(), deadline = started + 180000; let previous = '', lastOutput = 0;
  await json(`/api/documents/${spectrum.id}/pdf`, {method: 'POST', body: {ocrLanguage: 'eng'}});
  while (Date.now() < deadline) {
    const source = row("SELECT * FROM document_representations WHERE document_version_id=? AND kind='pdf'", spectrum.version_id);
    const job = row('SELECT status FROM import_jobs WHERE pdf_target_version_id=? ORDER BY created_at DESC LIMIT 1', spectrum.version_id);
    requireCheck(job?.status !== 'failed' && !['failed', 'cancelled'].includes(source?.status), 'spectrum_pdf_preparation_failed');
    const manifest = source?.pdf_hash ? await json(`/api/representations/${source.id}/manifest`, {timeoutMs: deadline - Date.now()}) : undefined;
    const indexedPages = manifest?.pages.filter(page => page.textStatus !== 'pending').length ?? 0;
    const state = {status: source?.status ?? job?.status ?? 'preparing', indexedPages, totalPages: source?.page_count ?? 7};
    if (JSON.stringify(state) !== previous || Date.now() - lastOutput > 15000) {emit({...state, elapsedSeconds: Math.floor((Date.now() - started) / 1000)}); previous = JSON.stringify(state); lastOutput = Date.now();}
    if (manifest && ['ready', 'partial'].includes(source.status)) return source;
    await delay(Math.min(2000, Math.max(1, deadline - Date.now())));
  }
  throw new AcceptanceFailure('spectrum_pdf_wait_timed_out_180s');
}
async function verifySpectrumPdf(source, dataRoot) {
  const manifest = await json(`/api/representations/${source.id}/manifest`);
  requireCheck(manifest.pages.length === 7 && manifest.pages.every((page, index) => page.page === index + 1 && page.sourcePage === index + 22), 'spectrum_pdf_page_mapping_mismatch');
  const original = await fileFingerprint(source.source_path, dataRoot), derivative = await fileFingerprint(source.pdf_path, dataRoot);
  requireCheck(original.bytes > 5 && derivative.bytes > 5 && original.sha256 === source.source_hash && derivative.sha256 === source.pdf_hash, 'pdf_file_integrity_mismatch');
  if (options.expectedHash) requireCheck(original.sha256 === options.expectedHash.toLowerCase(), 'original_pdf_expected_hash_mismatch');
  const denied = await request(`/api/representations/${source.id}/pdf`, {authenticated: false});
  requireCheck(denied.status === 401, 'unauthenticated_pdf_must_be_denied', denied.status); await denied.body?.cancel();
  const range = await request(`/api/representations/${source.id}/pdf`, {headers: {range: 'bytes=0-31'}});
  requireCheck(range.status === 206 && range.headers.get('content-range') === `bytes 0-31/${derivative.bytes}`, 'pdf_byte_range_invalid', range.status);
  const firstBytes = Buffer.from(await range.arrayBuffer()); requireCheck(firstBytes.length === 32 && firstBytes.subarray(0, 5).toString() === '%PDF-', 'pdf_byte_range_payload_invalid');
  const full = await request(`/api/representations/${source.id}/pdf`);
  requireCheck(full.status === 200 && /application\/pdf/i.test(full.headers.get('content-type') ?? ''), 'pdf_download_invalid', full.status);
  const hash = createHash('sha256'); let bytes = 0; for await (const chunk of full.body) {hash.update(chunk); bytes += chunk.length;}
  requireCheck(bytes === derivative.bytes && hash.digest('hex') === derivative.sha256, 'pdf_download_bytes_mismatch');
  const hits = await json(`/api/representations/${source.id}/search?` + new URLSearchParams({q: 'mathematician'}));
  requireCheck(Array.isArray(hits) && hits.length > 0 && hits.every(hit => Number.isInteger(hit.page) && hit.page >= 1 && hit.page <= 7 && typeof hit.excerpt === 'string'), 'spectrum_pdf_search_invalid');
  return {pages: 7, sourceBytes: original.bytes, derivativeBytes: derivative.bytes, byteRangeStatus: 206, searchHits: hits.length, expectedSourceHashMatched: options.expectedHash ? true : null};
}
async function main() {
  options = parseArguments(); if (options.help) {console.log(usage); return;}
  origin = new URL(options.origin ?? `http://127.0.0.1:${process.env.PROFREAD_PORT ?? 4310}`);
  requireCheck(['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname) && ['http:', 'https:'].includes(origin.protocol) && !origin.username && !origin.password && origin.pathname === '/' && !origin.search && !origin.hash, 'loopback_origin_required');
  const dataRoot = await realpath(process.env.PROFREAD_DATA_DIR ?? '/data');
  db = new DatabaseSync(join(dataRoot, 'profread.sqlite'), {readOnly: true});
  const before = await snapshot(dataRoot);
  if (options.baselinePath) {let baseline; try {baseline = JSON.parse(await readFile(resolve(options.baselinePath), 'utf8'));} catch {throw new AcceptanceFailure('baseline_unreadable');} compareBaseline(baseline, before);}
  await login();
  const initial = await verifyLibrary(); let source;
  if (options.mode === 'enable-spectrum-pdf') source = await enableSpectrumPdf(initial.spectrum);
  else source = row("SELECT * FROM document_representations WHERE document_version_id=? AND kind='pdf'", initial.spectrum.version_id);
  const pdf = source ? await verifySpectrumPdf(source, dataRoot) : null;
  const result = options.mode === 'enable-spectrum-pdf' ? await verifyLibrary() : initial;
  const after = await snapshot(dataRoot); compareBaseline(before, after);
  if (options.saveBaselinePath) {
    try {await writeFile(resolve(options.saveBaselinePath), JSON.stringify(after, null, 2) + '\n', {flag: 'wx', mode: 0o600});} catch {throw new AcceptanceFailure('baseline_save_failed_or_exists');}
  }
  const representations = rows('SELECT r.id,r.kind,r.document_version_id FROM document_representations r JOIN document_versions v ON v.id=r.document_version_id WHERE v.document_id=? ORDER BY r.kind,r.id', result.spectrum.id);
  finalResult = {status: 'passed', mode: options.mode, ...result.counts, htmlFilesVerified: after.htmlFiles.length, preserved: true, providerRunsAdded: 0, spectrum: {documentId: result.spectrum.id, versionId: result.spectrum.version_id, representations: representations.map(value => ({id: value.id, kind: value.kind, documentVersionId: value.document_version_id}))}, pdf};
}
try {await main();}
catch (error) {finalResult = {status: 'failed', check: error instanceof AcceptanceFailure ? error.check : 'unexpected_acceptance_failure', ...(error instanceof AcceptanceFailure && error.httpStatus ? {httpStatus: error.httpStatus} : {})}; process.exitCode = 1;}
finally {
  if (cookie && csrf) {
    try {const response = await request('/api/auth/logout', {method: 'POST', body: {}}); await response.body?.cancel(); requireCheck(response.ok, 'logout_failed', response.status);} catch {finalResult = {status: 'failed', check: 'session_cleanup_failed'}; process.exitCode = 1;}
  }
  db?.close();
  if (finalResult) emit(finalResult);
}
