import {randomUUID} from 'node:crypto';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import type {PdfPage} from '@profread/shared';
import {buildApp} from '../app.js';
import {db, now, row} from '../db/index.js';
import {importSource} from '../ingest/index.js';
import {createPdfAnchor, savePdfPages} from '../pdf/repository.js';
import {finalizeSummaryReview, latestSummaryReview, prepareSummaryReview, startSummaryReview, summaryBasis} from './summary-review.js';

const app = await buildApp();
let cookie = '', csrf = '';
beforeAll(async () => {
  const login = await app.inject({method: 'POST', url: '/api/auth/login', payload: {password: 'test-owner-password'}});
  cookie = login.cookies.map(item => `${item.name}=${item.value}`).join('; ');
  csrf = login.cookies.find(item => item.name === 'profread_csrf')!.value;
});
afterAll(() => app.close());
const headers = () => ({cookie, 'x-csrf-token': csrf});

async function fixture() {
  const imported = await importSource({buffer: Buffer.from(`<title>Two source views ${randomUUID()}</title><p>HTML-only article content</p>`), filename: `summary-source-${randomUUID()}.html`, mimeType: 'text/html'});
  const documentId = imported.documentId!, versionId = imported.versionId!, representationId = randomUUID(), sourceHash = 'f'.repeat(64), time = now();
  db.prepare("INSERT INTO document_representations(id,document_version_id,kind,status,source_hash,pdf_hash,page_count,created_at,updated_at)VALUES(?,?,'pdf','partial',?,?,2,?,?)").run(representationId, versionId, sourceHash, sourceHash, time, time);
  const text = 'Native PDF-only content', pages: PdfPage[] = [
    {page: 1, sourcePage: 21, label: '20', view: [0, 0, 600, 800], rotation: 0, text, transcript: 'Native PDF-only transcript.', textStatus: 'native', items: [{text, start: 0, end: text.length, quad: [20, 760, 240, 760, 240, 748, 20, 748]}]},
    {page: 2, sourcePage: 22, view: [0, 0, 600, 800], rotation: 90, text: '', textStatus: 'pending', items: []},
  ];
  savePdfPages(representationId, pages);
  return {documentId, versionId, representationId, sourceHash, pages};
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function artifact(source: Fixture, pdf = false, content = '- Original summary') {
  const response = await app.inject({method: 'POST', url: '/api/artifacts', headers: headers(), payload: {documentVersionId: source.versionId, ...(pdf ? {representationId: source.representationId} : {}), kind: 'tldr', scopeType: 'document', scopeId: source.documentId, content, sourceRefs: [pdf ? source.representationId : source.versionId]}});
  expect([200, 201], response.body).toContain(response.statusCode);
  return response.json<{id: string; version: number; basis: ReturnType<typeof summaryBasis>}>();
}
function pdfSignal(source: Fixture) {
  const text = source.pages[0]!.text, anchor = createPdfAnchor(source.versionId, {kind: 'pdf-text', representationId: source.representationId, sourceHash: source.sourceHash, extractionRevision: summaryBasis(source.versionId, source.representationId).extractionRevision, exact: text, segments: [{page: 1, startOffset: 0, endOffset: text.length, exact: text, quads: [source.pages[0]!.items[0]!.quad]}]});
  const id = randomUUID(), time = now();
  db.prepare("INSERT INTO highlights(id,anchor_id,checked,color,kind,note,created_at,updated_at)VALUES(?,?,1,'pink','comment','Discuss the PDF claim',?,?)").run(id, anchor.id, time, time);
  return id;
}
function htmlSignal(source: Fixture) {
  const block = row<{id: string; text_content: string; start_offset: number; end_offset: number}>("SELECT id,text_content,start_offset,end_offset FROM blocks WHERE document_version_id=? AND block_type='text' ORDER BY ordinal DESC LIMIT 1", source.versionId)!, anchorId = randomUUID(), time = now();
  db.prepare("INSERT INTO anchors(id,document_version_id,block_id,exact_quote,prefix_text,suffix_text,start_offset,end_offset,block_type,created_at)VALUES(?,?,?,?,'','',?,?,'text',?)").run(anchorId, source.versionId, block.id, block.text_content, block.start_offset, block.end_offset, time);
  db.prepare("INSERT INTO highlights(id,anchor_id,checked,color,kind,created_at,updated_at)VALUES(?,?,1,'yellow','important',?,?)").run(randomUUID(), anchorId, time, time);
}
function runId() {
  const id = randomUUID();
  db.prepare("INSERT INTO model_runs(id,request_id,action,profile,routing_reason,context_tier,status,created_at)VALUES(?,?,'review-summary','digest','test PDF review','canonical','running',?)").run(id, randomUUID(), now());
  return id;
}

describe('PDF and HTML summary coexistence', () => {
  it('preserves separate document summaries and accepts only the PDF extraction basis', async () => {
    const source = await fixture(), html = await artifact(source), pdf = await artifact(source, true);
    expect(pdf.id).not.toBe(html.id);
    expect(pdf.version).toBe(2);
    expect(pdf.basis).toMatchObject({representationId: source.representationId, extractionRevision: 1, revision: 0});
    const updatedHtml = await artifact(source, false, '- Updated HTML summary');
    expect(updatedHtml).toMatchObject({id: html.id, version: 3});
    const list = async () => (await app.inject({method: 'GET', url: `/api/documents/${source.documentId}/artifacts`, headers: headers()})).json<Array<{id: string; version: number; content: string; representation_id: string | null; freshness: {status: string; reasons: string[]}}>>();
    expect(await list()).toHaveLength(2);
    savePdfPages(source.representationId, [{...source.pages[1]!, textStatus: 'image-only'}]);
    const values = await list();
    expect(values.find(item => item.id === html.id)).toMatchObject({content: '- Updated HTML summary', representation_id: null, freshness: {status: 'current'}});
    expect(values.find(item => item.id === pdf.id)).toMatchObject({representation_id: source.representationId, freshness: {status: 'needs-review', reasons: ['pdf-extraction-changed']}});
    const accepted = await app.inject({method: 'POST', url: `/api/artifacts/${pdf.id}/accept-current-basis`, headers: headers(), payload: {expectedArtifactVersion: 2}});
    expect(accepted.statusCode, accepted.body).toBe(200);
    expect(row<{version: number; basis_extraction_revision: number}>('SELECT version,basis_extraction_revision FROM artifacts WHERE id=?', pdf.id)).toEqual({version: 4, basis_extraction_revision: 2});
    expect((await list()).find(item => item.id === html.id)?.version).toBe(3);
  });

  it('scopes reader signals and uses a page-labelled PDF transcript without HTML fallback', async () => {
    const source = await fixture(), htmlBasis = summaryBasis(source.versionId), pdf = await artifact(source, true), signalId = pdfSignal(source);
    expect(summaryBasis(source.versionId)).toEqual(htmlBasis);
    const pdfBasis = summaryBasis(source.versionId, source.representationId);
    htmlSignal(source);
    db.prepare('INSERT INTO document_edit_revisions(id,document_version_id,revision,edited_html_path,canonical_text,base_title,summary_json,created_at)VALUES(?,?,1,?,?,?,?,?)').run(randomUUID(), source.versionId, '/tmp/unused-pdf-summary-edit.html', 'Edited HTML-only content', 'HTML edit', '{}', now());
    expect(summaryBasis(source.versionId, source.representationId)).toEqual(pdfBasis);
    const snapshot = prepareSummaryReview({artifactId: pdf.id, expectedArtifactVersion: pdf.version, documentId: source.documentId, documentVersionId: source.versionId, representationId: source.representationId});
    expect(snapshot.article).toContain('PDF page 21; printed page 20');
    expect(snapshot.article).toContain('indexed text 1/2 pages');
    expect(snapshot.article).toContain('Native PDF-only transcript.');
    expect(snapshot.article).not.toContain('HTML-only');
    expect(snapshot.signals).toHaveLength(1);
    expect(snapshot.signals[0]).toMatchObject({id: signalId, selector: {representationId: source.representationId}});
    expect(() => prepareSummaryReview({artifactId: pdf.id, expectedArtifactVersion: pdf.version, documentId: source.documentId, documentVersionId: source.versionId, representationId: `html-${source.versionId}`})).toThrow('does not match');
    const review = startSummaryReview(runId(), snapshot);
    const outcome = finalizeSummaryReview({reviewId: review.reviewId, modelId: 'review-fixture', result: {decision: 'KEEP', rationale: 'The PDF claim is covered.', sourceStatus: 'adequate', signalCoverage: [{signalId, status: 'covered'}]}});
    expect(outcome).toMatchObject({applied: true, freshness: {status: 'current'}, basis: {representationId: source.representationId, extractionRevision: 1}});
    expect(latestSummaryReview(pdf.id)?.basis).toMatchObject({representationId: source.representationId, extractionRevision: 1});
  });

  it('supersedes a review when the PDF extraction advances while the model is working', async () => {
    const source = await fixture(), pdf = await artifact(source, true), signalId = pdfSignal(source);
    const review = startSummaryReview(runId(), prepareSummaryReview({artifactId: pdf.id, expectedArtifactVersion: pdf.version, documentId: source.documentId, documentVersionId: source.versionId}));
    savePdfPages(source.representationId, [{...source.pages[1]!, textStatus: 'image-only'}]);
    const outcome = finalizeSummaryReview({reviewId: review.reviewId, modelId: 'review-fixture', result: {decision: 'REPLACE', rationale: 'Proposed from the previous extraction.', sourceStatus: 'adequate', signalCoverage: [{signalId, status: 'missing'}], replacement: {kind: 'tldr', content: '- Would replace the PDF summary'}}});
    expect(outcome).toMatchObject({applied: false, supersededReason: 'basis-changed'});
    expect(row<{content_json: string}>('SELECT content_json FROM artifacts WHERE id=?', pdf.id)?.content_json).toBe(JSON.stringify('- Original summary'));
  });
});
