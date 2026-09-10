import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { zipSync } from 'fflate';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PdfPage, SourceCitation } from '@profread/shared';

const worker = vi.hoisted(() => ({ crop: vi.fn() }));
vi.mock('../academic/worker-client.js', async original => ({
  ...await original<typeof import('../academic/worker-client.js')>(), cropReadingPdf: worker.crop,
}));

import { buildApp } from '../app.js';
import { config } from '../config.js';
import { db, now, row, rows } from '../db/index.js';
import { importSource } from '../ingest/index.js';
import { createPdfAnchor, savePdfPages } from './repository.js';

process.env.OPENAI_API_KEY = 'test-openai-key';
const app = await buildApp();
let headers: Record<string, string> = {};
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const providerBodies: Record<string, unknown>[] = [];
let answer = 'The stored diagram supports the argument [pdf-selection] [pdf-p22].';

beforeAll(async () => {
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', remoteAddress: '127.0.3.22', payload: { password: 'test-owner-password' } });
  expect(login.statusCode).toBe(200);
  headers = { cookie: login.cookies.map(item => `${item.name}=${item.value}`).join('; '), 'x-csrf-token': login.cookies.find(item => item.name === 'profread_csrf')!.value };
});
afterAll(async () => { vi.unstubAllGlobals(); delete process.env.OPENAI_API_KEY; await app.close(); });

beforeEach(() => {
  vi.clearAllMocks(); providerBodies.length = 0;
  answer = 'The stored diagram supports the argument [pdf-selection] [pdf-p22].';
  worker.crop.mockImplementation(async (path: string, options: { page: number; x: number; y: number; width: number; height: number }) => {
    const source = await readFile(path);
    const crop = Buffer.from(JSON.stringify({ readerPage: options.page, rect: [options.x, options.y, options.x + options.width, options.y + options.height], width: 1, height: 1 }));
    const manifest = Buffer.from(JSON.stringify({ schemaVersion: 1, operation: 'pdf-crop', source: { kind: 'pdf', sha256: hash(source) }, output: { entryPath: 'crop.json', imagePath: 'crop.png' }, warnings: [], files: [{ path: 'crop.json', bytes: crop.length, sha256: hash(crop) }, { path: 'crop.png', bytes: png.length, sha256: hash(png) }] }));
    return Buffer.from(zipSync({ 'manifest.json': manifest, 'crop.json': crop, 'crop.png': png }));
  });
  vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init?: RequestInit) => {
    providerBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    const chunks = [
      `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: answer })}\n\n`,
      `data: ${JSON.stringify({ type: 'response.completed', response: { id: randomUUID(), status: 'completed', usage: { input_tokens: 40, output_tokens: 12 } } })}\n\n`,
    ];
    return new Response(new ReadableStream({ start(controller) { for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk)); controller.close(); } }), { status: 200 });
  }));
});

async function fixture(coexisting = false) {
  const time = now(), representationId = randomUUID();
  let documentId: string, versionId: string;
  if (coexisting) {
    const imported = await importSource({ buffer: Buffer.from(`<title>Coexisting summaries ${randomUUID()}</title><p>The HTML article supplies independently curated study notes.</p>`), filename: 'coexisting.html', mimeType: 'text/html' });
    documentId = imported.documentId!; versionId = imported.versionId!;
  } else {
    documentId = randomUUID(); versionId = randomUUID();
    db.prepare('INSERT INTO documents(id,title,created_at)VALUES(?,?,?)').run(documentId, 'Source-bound PDF discussion', time);
    db.prepare("INSERT INTO document_versions(id,document_id,content_hash,source_name,entry_path,sanitized_html_path,canonical_text,token_estimate,version,created_at)VALUES(?,?,?,?,NULL,NULL,'',0,1,?)").run(versionId, documentId, randomUUID(), 'magazine.pdf', time);
  }
  const directory = join(config.dataDir, 'pdf', representationId), path = join(directory, 'reading.pdf'), originalPath = join(directory, 'original.pdf');
  const original = Buffer.from(`%PDF-1.7\nOriginal whole magazine ${randomUUID()}\n%%EOF`), reading = Buffer.from(`%PDF-1.7\nSelected source pages 22-23 ${randomUUID()}\n%%EOF`);
  await mkdir(directory, { recursive: true }); await writeFile(path, reading); await writeFile(originalPath, original);
  db.prepare("INSERT INTO document_representations(id,document_version_id,kind,status,source_hash,source_path,pdf_hash,pdf_path,source_page_start,source_page_end,page_count,created_at,updated_at)VALUES(?,?,'pdf','indexing',?,?,?,?,22,23,2,?,?)").run(representationId, versionId, hash(original), originalPath, hash(reading), path, time, time);
  const pages: PdfPage[] = [1, 2].map(page => ({ page, sourcePage: page + 21, view: [0, 0, 600, 800], rotation: 0, text: `The mathematician explains a source-bound diagram and proof on source page ${page + 21}.`, textStatus: 'native', items: [] }));
  const revision = savePdfPages(representationId, pages);
  const selector = { kind: 'pdf-region' as const, representationId, sourceHash: hash(original), extractionRevision: revision, exact: '', segments: [{ page: 1, quads: [[50, 700, 150, 700, 150, 600, 50, 600] as [number, number, number, number, number, number, number, number]] }] };
  const anchor = createPdfAnchor(versionId, selector);
  return { documentId, versionId, representationId, anchorId: anchor.id, path, selector, original, reading };
}

async function createThread(source: Awaited<ReturnType<typeof fixture>>, extra: Record<string, unknown> = {}) {
  const created = await app.inject({ method: 'POST', url: '/api/threads', headers, payload: { documentId: source.documentId, representationId: source.representationId, ...extra } });
  expect(created.statusCode, created.body).toBe(201);
  return created.json<{ id: string }>().id;
}
async function run(source: Awaited<ReturnType<typeof fixture>>, extra: Record<string, unknown> = {}) {
  return app.inject({ method: 'POST', url: '/api/runs', headers, payload: { requestId: randomUUID(), documentVersionId: source.versionId, representationId: source.representationId, action: 'ask', input: 'Explain the selected diagram.', modelOverride: 'gpt-5.6-sol', ...extra } });
}
function sseData<T = Record<string, unknown>>(body: string, name: string): T[] {
  return body.split('\n\n').filter(event => event.startsWith(`event: ${name}\n`)).map(event => JSON.parse(event.split('\ndata: ')[1]!) as T);
}
type ListedThread = { id: string; messages: string };
type ListedMessage = { id: string; role: string; content: string; modelRunId?: string; sourceCitations: SourceCitation[] };
async function messages(documentId: string, threadId: string): Promise<ListedMessage[]> {
  const listed = await app.inject({ method: 'GET', url: `/api/documents/${documentId}/threads`, headers });
  expect(listed.statusCode, listed.body).toBe(200);
  return JSON.parse(listed.json<ListedThread[]>().find(thread => thread.id === threadId)!.messages) as ListedMessage[];
}

describe('source-bound PDF AI runs', () => {
  it('sends server-issued region evidence again for an anchorless nested answer followup, ignoring client screenshots', async () => {
    const source = await fixture(), threadId = await createThread(source, { anchorId: source.anchorId });
    const userQuestion = 'Explain the original source diagram before discussing the proof.';
    await app.inject({ method: 'POST', url: `/api/threads/${threadId}/messages`, headers, payload: { role: 'user', content: userQuestion } });
    const clientScreenshot = Buffer.concat([png, Buffer.from('untrusted-browser-screenshot')]).toString('base64');
    const initial = await run(source, { threadId, anchorId: source.anchorId, visual: { mimeType: 'image/png', data: clientScreenshot } });
    expect(initial.statusCode, initial.body).toBe(200); expect(initial.body).toContain('event: done'); expect(initial.body).not.toContain('event: error');
    expect(providerBodies).toHaveLength(1);
    expect(JSON.stringify(providerBodies[0])).toContain(`data:image/png;base64,${png.toString('base64')}`);
    expect(JSON.stringify(providerBodies[0])).not.toContain(clientScreenshot);
    expect(worker.crop).toHaveBeenCalledWith(source.path, { page: 1, x: 50, y: 600, width: 100, height: 100 }, expect.any(AbortSignal));
    const firstAssistant = (await messages(source.documentId, threadId)).find(message => message.role === 'assistant')!;
    const childThreadId = await createThread(source, { parentMessageId: firstAssistant.id });
    expect(row<{ anchor_id: string | null }>('SELECT anchor_id FROM threads WHERE id=?', childThreadId)?.anchor_id).toBeNull();
    worker.crop.mockClear();
    answer = 'The proof follows from the same visual premises [pdf-selection].';
    const followup = await run(source, { threadId: childThreadId, input: 'How does that support the proof?' });
    expect(followup.body).toContain('event: done'); expect(followup.body).not.toContain('event: error');
    expect(providerBodies).toHaveLength(2);
    expect(worker.crop).toHaveBeenCalledWith(source.path, { page: 1, x: 50, y: 600, width: 100, height: 100 }, expect.any(AbortSignal));
    expect(JSON.stringify(providerBodies[1])).toContain(userQuestion);
    expect(JSON.stringify(providerBodies[1])).toContain(firstAssistant.content);
    expect(JSON.stringify(providerBodies[1])).toContain(`data:image/png;base64,${png.toString('base64')}`);
    expect(providerBodies[1]).not.toHaveProperty('previous_response_id');
    expect(sseData(followup.body, 'source_context')[0]).toMatchObject({ representationId: source.representationId });
  });

  it('persists only server-known citations and returns stable evidence IDs and selectors when discussions reload', async () => {
    const source = await fixture(), threadId = await createThread(source, { anchorId: source.anchorId });
    answer = 'The diagram is visible [pdf-selection], with page context [pdf-p22]. Invented page [pdf-p999] must not become a source link.';
    const response = await run(source, { threadId, anchorId: source.anchorId });
    expect(response.body).toContain('event: done');
    const event = sseData<{ citations: SourceCitation[] }>(response.body, 'source_citations')[0]!;
    expect(event.citations.map(citation => citation.id).sort()).toEqual(['pdf-p22', 'pdf-selection']);
    const assistant = (await messages(source.documentId, threadId)).find(message => message.role === 'assistant')!;
    expect(assistant.content).toContain('[pdf-p999]');
    expect(assistant.sourceCitations.map(citation => citation.id).sort()).toEqual(['pdf-p22', 'pdf-selection']);
    expect(assistant.sourceCitations.find(citation => citation.id === 'pdf-selection')?.selector).toEqual(source.selector);
    expect(assistant.sourceCitations.every(citation => citation.selector.representationId === source.representationId)).toBe(true);
    expect(rows<{ evidence_id: string }>('SELECT evidence_id FROM source_citations WHERE model_run_id=? ORDER BY evidence_id', assistant.modelRunId).map(citation => citation.evidence_id)).toEqual(['pdf-p22', 'pdf-selection']);
    expect(row<{ extraction_revision: number; representation_id: string }>('SELECT extraction_revision,representation_id FROM pdf_run_basis WHERE model_run_id=?', assistant.modelRunId)).toMatchObject({ extraction_revision: source.selector.extractionRevision, representation_id: source.representationId });
  });

  it('rejects another representation before a provider call or saved run, including mismatched nested discussions', async () => {
    const source = await fixture(), other = await fixture(), threadId = await createThread(source, { anchorId: source.anchorId });
    for (const scope of [{}, { threadId, anchorId: source.anchorId }]) {
      const requestId = randomUUID(), response = await run(source, { requestId, representationId: other.representationId, ...scope });
      expect(response.statusCode, response.body).toBe(409);
      expect(row('SELECT id FROM model_runs WHERE request_id=?', requestId)).toBeUndefined();
    }
    const message = await app.inject({ method: 'POST', url: `/api/threads/${threadId}/messages`, headers, payload: { role: 'assistant', content: 'A source-bound answer.' } });
    const child = await app.inject({ method: 'POST', url: '/api/threads', headers, payload: { documentId: source.documentId, parentMessageId: message.json<{ id: string }>().id, representationId: other.representationId } });
    expect(child.statusCode, child.body).toBe(400);
    expect(providerBodies).toHaveLength(0); expect(worker.crop).not.toHaveBeenCalled();
  });

  it('replays validated citation metadata without another provider call or duplicate answer', async () => {
    const source = await fixture(), threadId = await createThread(source, { anchorId: source.anchorId }), requestId = randomUUID();
    const initial = await run(source, { requestId, threadId, anchorId: source.anchorId });
    expect(initial.body).toContain('event: done');
    const replay = await run(source, { requestId, threadId, anchorId: source.anchorId });
    expect(replay.body).toContain('event: done'); expect(replay.body).toContain('"replayed":true');
    const citations = (body: string) => sseData<{ citations: SourceCitation[] }>(body, 'source_citations')[0]?.citations.sort((a, b) => a.id.localeCompare(b.id));
    expect(citations(replay.body)).toEqual(citations(initial.body));
    expect(providerBodies).toHaveLength(1);
    expect((await messages(source.documentId, threadId)).filter(message => message.role === 'assistant')).toHaveLength(1);
  });

  it('keeps an original PDF discussion and new PDF questions usable after a newer HTML version is imported', async () => {
    const source = await fixture(true), threadId = await createThread(source, { anchorId: source.anchorId });
    const imported = await importSource({ documentId: source.documentId, buffer: Buffer.from(`<title>New HTML version ${randomUUID()}</title><p>HTML-only revision that must not silently replace the immutable PDF source.</p>`), filename: 'new-version.html', mimeType: 'text/html' });
    expect(imported.versionId).not.toBe(source.versionId);
    const existing = await run(source, { threadId, anchorId: source.anchorId });
    expect(existing.statusCode, existing.body).toBe(200); expect(existing.body).toContain('event: done'); expect(existing.body).not.toContain('event: error');
    expect(sseData(existing.body, 'source_context')[0]).toMatchObject({ representationId: source.representationId });
    const newThread = await createThread(source, { anchorId: source.anchorId });
    const question = await run(source, { threadId: newThread, anchorId: source.anchorId });
    expect(question.body).toContain('event: done'); expect(question.body).not.toContain('event: error');
    expect(JSON.stringify(providerBodies)).not.toContain('HTML-only revision that must not silently replace');
    expect((await messages(source.documentId, newThread)).find(message => message.role === 'assistant')?.sourceCitations[0]?.selector.representationId).toBe(source.representationId);
  });

  it('fails a tampered immutable PDF before sending source images or text to a provider', async () => {
    const source = await fixture(), threadId = await createThread(source, { anchorId: source.anchorId });
    await writeFile(source.path, '%PDF-1.7\nTampered derivative');
    const requestId = randomUUID(), response = await run(source, { requestId, threadId, anchorId: source.anchorId });
    expect(response.body).toContain('event: error'); expect(response.body).toContain('integrity check'); expect(response.body).not.toContain('event: done');
    expect(providerBodies).toHaveLength(0); expect(worker.crop).not.toHaveBeenCalled();
    expect(row<{ status: string }>('SELECT status FROM model_runs WHERE request_id=?', requestId)?.status).toBe('failed');
    expect((await messages(source.documentId, threadId)).filter(message => message.role === 'assistant')).toEqual([]);
  });

  it('keeps coexisting HTML and PDF document summaries in separate representation-scoped artifacts', async () => {
    const source = await fixture(true), htmlId = row<{ id: string }>("SELECT id FROM document_representations WHERE document_version_id=? AND kind='html'", source.versionId)!.id;
    const summaryScope = { action: 'tldr', input: '', artifactScopeType: 'document', artifactScopeId: source.documentId };
    answer = 'HTML-only study summary.';
    const html = await run(source, { ...summaryScope, representationId: htmlId }); expect(html.body).toContain('event: done'); expect(html.body).not.toContain('event: error');
    answer = 'PDF-only source summary [pdf-p22] [pdf-p23].';
    const pdf = await run(source, summaryScope); expect(pdf.body).toContain('event: done'); expect(pdf.body).not.toContain('event: error');
    const artifacts = () => rows<{ id: string; representation_id: string | null; content_json: string; version: number }>("SELECT id,representation_id,content_json,version FROM artifacts WHERE document_version_id=? AND kind='tldr'", source.versionId);
    expect(artifacts()).toHaveLength(2);
    // NULL is the deliberate canonical legacy HTML artifact namespace.
    const htmlArtifact = artifacts().find(artifact => artifact.representation_id === null)!;
    expect(htmlArtifact?.content_json).toBe(JSON.stringify('HTML-only study summary.'));
    expect(artifacts().find(artifact => artifact.representation_id === source.representationId)?.content_json).toContain('PDF-only source summary');
    answer = 'Updated PDF-only source summary [pdf-p22].';
    const rerun = await run(source, summaryScope); expect(rerun.body).toContain('event: done'); expect(rerun.body).not.toContain('event: error');
    expect(artifacts()).toHaveLength(2);
    expect(artifacts().find(artifact => artifact.id === htmlArtifact.id)).toEqual(htmlArtifact);
    expect(artifacts().find(artifact => artifact.representation_id === source.representationId)?.content_json).toContain('Updated PDF-only');
    expect(await readFile(source.path)).toEqual(source.reading);
  });
});
