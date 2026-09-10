import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { PdfPage } from '@profread/shared';
import { describe, expect, it } from 'vitest';
import { config } from '../config.js';
import { db, now } from '../db/index.js';
import { buildPdfContext, buildPdfSummaryChunks, pdfPageNeedsImage, rankPdfPages } from './context.js';
import { createPdfAnchor, savePdfPages } from './repository.js';

export function testPage(page: number, text: string, textStatus: PdfPage['textStatus'] = 'native'): PdfPage {
  return { page, sourcePage: page + 21, view: [0, 0, 600, 800], rotation: 0, text, transcript: text, textStatus,
    items: text ? [{ text, start: 0, end: text.length, quad: [50, 720, 550, 720, 550, 700, 50, 700] }] : [] };
}
export async function pdfFixture(pages: PdfPage[], status = 'ready') {
  const versionId = randomUUID(), documentId = randomUUID(), representationId = randomUUID(), time = now();
  const directory = join(config.dataDir, 'pdf', representationId), sourceBytes = Buffer.from('%PDF-1.7\nfixture');
  await mkdir(directory, { recursive: true }); await writeFile(join(directory, 'reading.pdf'), sourceBytes);
  const hash = createHash('sha256').update(sourceBytes).digest('hex');
  db.prepare('INSERT INTO documents(id,title,created_at)VALUES(?,?,?)').run(documentId, 'PDF source fixture', time);
  db.prepare("INSERT INTO document_versions(id,document_id,content_hash,source_name,entry_path,sanitized_html_path,canonical_text,token_estimate,version,created_at)VALUES(?,?,?,?,NULL,NULL,'',0,1,?)").run(versionId, documentId, randomUUID(), 'fixture.pdf', time);
  db.prepare("INSERT INTO document_representations(id,document_version_id,kind,status,source_hash,source_path,pdf_hash,pdf_path,source_page_start,source_page_end,page_count,created_at,updated_at)VALUES(?,?,'pdf',?,?,?,?,?,22,?,?,?,?)").run(representationId, versionId, status, hash, join(directory, 'reading.pdf'), hash, join(directory, 'reading.pdf'), 21 + pages.length, pages.length, time, time);
  const revision = savePdfPages(representationId, pages);
  return { versionId, documentId, representationId, hash, revision, pdfPath: join(directory, 'reading.pdf') };
}

describe('PDF source context', () => {
  it('retrieves relevant late pages instead of always taking the beginning', () => {
    const pages = Array.from({ length: 12 }, (_, index) => testPage(index + 1, index === 11 ? 'Aletheia proved the difficult conjecture.' : 'Ordinary introduction.'));
    expect(rankPdfPages(pages, 'Explain the Aletheia conjecture')[0]?.page).toBe(12);
    expect(rankPdfPages(pages, 'Aletheia', [9, 8, 10]).slice(0, 3).map(page => page.page)).toEqual([9, 8, 10]);
  });
  it('includes every selected article page in summary context and all tails in chunks', async () => {
    const fixture = await pdfFixture([testPage(1, 'Opening. '.repeat(6000) + 'FIRST PAGE TAIL'), testPage(2, 'Middle. '.repeat(6000) + 'SECOND PAGE TAIL'), testPage(3, 'Last page conclusion.')]);
    const snapshot = buildPdfContext({ documentVersionId: fixture.versionId, representationId: fixture.representationId, profile: 'quick', query: '', action: 'summarize', contextWindow: 16_000 });
    expect(snapshot.context.article).toContain('Last page conclusion.');
    expect(snapshot.coverage.includedPages).toEqual([22, 23, 24]); expect(snapshot.requiresChunking).toBe(true);
    const chunks = buildPdfSummaryChunks(snapshot, 16_000);
    expect(chunks.length).toBeGreaterThan(1); expect(chunks.at(-1)?.article).toContain('Last page conclusion.');
    expect(chunks.map(chunk => chunk.article).join('\n')).toContain('FIRST PAGE TAIL');
    expect(chunks.map(chunk => chunk.article).join('\n')).toContain('SECOND PAGE TAIL');
    expect([...new Set(chunks.flatMap(chunk => chunk.pageNumbers))]).toEqual([22, 23, 24]);
    expect(chunks.flatMap(chunk => chunk.citations).every(citation => citation.selector.sourceHash === fixture.hash)).toBe(true);
  });
  it('requires explicit partial summaries but permits questions about an unindexed saved region', async () => {
    const fixture = await pdfFixture([testPage(1, '', 'pending'), testPage(2, 'Later source text.')], 'indexing');
    const input = { documentVersionId: fixture.versionId, representationId: fixture.representationId, profile: 'quick', query: 'Summarize this article', action: 'summarize' };
    expect(() => buildPdfContext(input)).toThrow('indexing is incomplete');
    expect(buildPdfContext({ ...input, allowPartial: true }).coverage.pendingPages).toEqual([22]);
    const anchor = createPdfAnchor(fixture.versionId, { kind: 'pdf-region', representationId: fixture.representationId, sourceHash: fixture.hash, extractionRevision: fixture.revision, exact: '', segments: [{ page: 1, quads: [[50, 700, 150, 700, 150, 600, 50, 600]] }] });
    const selected = buildPdfContext({ ...input, action: 'explain', query: 'What does this figure mean?', anchorId: anchor.id });
    expect(selected.requiresVision).toBe(true); expect(selected.evidenceTargets[0]?.id).toBe('pdf-selection');
    expect(selected.context.article).toContain('No indexed text');
  });
  it('requires image-aware chunking when a summary has more visual pages than one request can include', async () => {
    const fixture = await pdfFixture(Array.from({ length: 5 }, (_, index) => testPage(index + 1, '', 'image-only')));
    const snapshot = buildPdfContext({ documentVersionId: fixture.versionId, representationId: fixture.representationId, profile: 'deep', query: '', action: 'summarize' });
    expect(snapshot.requiresChunking).toBe(true); expect(snapshot.requiresVision).toBe(true);
  });
  it('requires source images for low-confidence OCR even when a completed page contains recognized text', async () => {
    const pages = [testPage(1, 'Reliable native body.'), { ...testPage(2, 'Spurious illustration OCR', 'ocr'), confidence: 29.2 }];
    const fixture = await pdfFixture(pages);
    const snapshot = buildPdfContext({ documentVersionId: fixture.versionId, representationId: fixture.representationId, profile: 'deep', query: '', action: 'summarize' });
    expect(snapshot.requiresVision).toBe(true); expect(snapshot.coverage.lowConfidencePages).toEqual([23]);
    expect(snapshot.coverage.partial).toBe(false); expect(snapshot.evidenceTargets[0]?.id).toBe('pdf-p23');
    expect(snapshot.context.article).toContain('OCR/extraction is unreliable');
    expect(buildPdfSummaryChunks(snapshot)[0]?.article).toContain('OCR/extraction is unreliable');
    expect(pdfPageNeedsImage({ ...testPage(1, 'Native fallback text'), error: 'OCR failed: timeout' })).toBe(true);
    expect(pdfPageNeedsImage({ ...testPage(1, 'Adequate OCR', 'ocr'), confidence: 70 })).toBe(false);
    expect(pdfPageNeedsImage({ ...testPage(1, 'Uncertain OCR', 'ocr'), confidence: 69.9 })).toBe(true);
    const many = await pdfFixture(Array.from({ length: 5 }, (_, index) => ({ ...testPage(index + 1, 'Spurious text', 'ocr'), confidence: 29 })));
    expect(buildPdfContext({ documentVersionId: many.versionId, representationId: many.representationId, profile: 'deep', query: '', action: 'summarize' }).requiresChunking).toBe(true);
  });
  it('keeps old selected text evidence after OCR reindexing and includes scoped reader signals and branch history', async () => {
    const fixture = await pdfFixture([testPage(1, 'Original selected words.')]);
    const anchor = createPdfAnchor(fixture.versionId, { kind: 'pdf-text', representationId: fixture.representationId, sourceHash: fixture.hash, extractionRevision: fixture.revision, exact: 'Original', segments: [{ page: 1, quads: [[50, 720, 150, 720, 150, 700, 50, 700]], startOffset: 0, endOffset: 8, exact: 'Original' }] });
    const threadId = randomUUID(), time = now();
    db.prepare('INSERT INTO threads(id,document_id,anchor_id,representation_id,created_at,updated_at)VALUES(?,?,?,?,?,?)').run(threadId, fixture.documentId, anchor.id, fixture.representationId, time, time);
    db.prepare('INSERT INTO messages(id,thread_id,role,content,created_at)VALUES(?,?,?,?,?)').run(randomUUID(), threadId, 'user', 'Prior follow-up question', time);
    db.prepare('INSERT INTO highlights(id,anchor_id,kind,note,created_at,updated_at)VALUES(?,?,?,?,?,?)').run(randomUUID(), anchor.id, 'question', 'What supports this?', time, time);
    savePdfPages(fixture.representationId, [testPage(1, 'Updated OCR words.')]);
    const snapshot = buildPdfContext({ documentVersionId: fixture.versionId, representationId: fixture.representationId, profile: 'quick', query: 'Follow-up', anchorId: anchor.id, threadId });
    expect(snapshot.context.anchor).toBe('Original'); expect(snapshot.citations[0]?.selector.extractionRevision).toBe(fixture.revision);
    expect(snapshot.context.article).toContain('Updated OCR words.'); expect(snapshot.context.branch[0]?.content).toBe('Prior follow-up question');
    expect(snapshot.context.curatedNotes[0]).toContain('[OPEN QUESTION]');
  });
});
