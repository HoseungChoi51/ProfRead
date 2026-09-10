import {renderToStaticMarkup} from 'react-dom/server';
import {describe, expect, it} from 'vitest';
import type {PdfManifest, PdfSelector} from '@profread/shared';
import {pdfTextSelector, pdfPageLabel} from './PdfReader.js';
import {matchesReadingSource, pdfSelectionForReader, sourceDocumentVersion, sourceRepresentationLabel, summaryReviewRequestIdentity, ThreadCard} from './Reader.js';
import {supportsPdfReadingFormat} from './AcademicImport.js';

const manifest: PdfManifest = {
  representationId: 'pdf-original', sourceHash: 'a'.repeat(64), pdfHash: 'b'.repeat(64), url: '/api/representations/pdf-original/pdf', extractionRevision: 2, status: 'ready', ocrLanguage: 'eng',
  pages: [
    {page: 1, sourcePage: 21, label: '20', view: [0, 0, 600, 800], rotation: 0, text: 'First line.\nNext line.', textStatus: 'native', items: [
      {text: 'First line.', start: 0, end: 11, quad: [20, 760, 130, 760, 130, 748, 20, 748]},
      {text: 'Next line.', start: 12, end: 22, quad: [20, 740, 120, 740, 120, 728, 20, 728]},
    ]},
    {page: 2, sourcePage: 22, view: [0, 0, 600, 800], rotation: 90, text: 'The next page.', textStatus: 'native', items: [
      {text: 'The next page.', start: 0, end: 14, quad: [20, 760, 160, 760, 160, 748, 20, 748]},
    ]},
  ],
};

describe('PDF interactions share the reader discussion model', () => {
  it('keeps HTML and PDF document summaries separate and retries against the exact PDF extraction', () => {
    expect(matchesReadingSource(null, 'pdf-original', true)).toBe(false);
    expect(matchesReadingSource('html-original', 'pdf-original', true)).toBe(false);
    expect(matchesReadingSource('pdf-original', 'pdf-original', true)).toBe(true);
    expect(matchesReadingSource(null, 'html-original', false)).toBe(true);
    expect(matchesReadingSource('pdf-original', 'html-original', false)).toBe(false);
    const identity = {artifactId: 'summary', artifactVersion: 2, documentVersionId: 'version', revision: 0, modelOverride: '', signals: [], representationId: 'pdf-original', extractionRevision: 2};
    expect(summaryReviewRequestIdentity(identity)).not.toBe(summaryReviewRequestIdentity({...identity, extractionRevision: 3}));
    const versions = {version_id: 'html-v2', representations: [{id: 'pdf-original', documentVersionId: 'original-v1', version: 1, kind: 'pdf' as const, status: 'ready' as const, extractionRevision: 2}]};
    expect(sourceDocumentVersion(versions, 'pdf-original')).toBe('original-v1');
    expect(sourceDocumentVersion(versions, null)).toBe('html-v2');
  });
  it('anchors multi-line and multi-page quotations to exact authoritative text ranges', () => {
    const selector = pdfTextSelector(manifest, [{page: 1, start: 6, end: 22}, {page: 2, start: 0, end: 8}])!;
    expect(selector).toMatchObject({kind: 'pdf-text', representationId: 'pdf-original', extractionRevision: 2, exact: 'line.\nNext line.\nThe next'});
    expect(selector.segments[0]).toMatchObject({page: 1, startOffset: 6, endOffset: 22, exact: 'line.\nNext line.'});
    expect(selector.segments[0]!.quads[0]).toEqual([80, 760, 130, 760, 130, 748, 80, 748]);
    expect(pdfPageLabel(manifest.pages[0]!)).toBe('Page 20 · PDF 21');
    expect(sourceRepresentationLabel({selector})).toBe('PDF');
    expect(sourceRepresentationLabel({block_id: 'legacy'})).toBe('HTML');
  });

  it('retains empty region text and PDF geometry instead of pretending a region is an HTML passage', () => {
    const selector: PdfSelector = {kind: 'pdf-region', representationId: manifest.representationId, sourceHash: manifest.sourceHash, extractionRevision: 2, exact: '', segments: [{page: 2, quads: [[10, 100, 90, 100, 90, 40, 10, 40]]}]};
    const selected = pdfSelectionForReader({selector, rect: {left: 100, top: 120, width: 80, height: 60}});
    expect(selected).toMatchObject({pdfSelector: selector, exact: '', blockType: 'image'});
    expect(selected.blockId).not.toBe('legacy');
  });

  it('shows durable source citations and hides document editing actions for PDF discussions', () => {
    const selector = pdfTextSelector(manifest, [{page: 2, start: 0, end: 8}])!;
    const markup = renderToStaticMarkup(<ThreadCard thread={{id: 'thread', document_id: 'article', anchor_id: 'anchor', selector, messages: [{id: 'answer', role: 'assistant', content: 'A grounded explanation.', createdAt: 'now', sourceCitations: [{id: 'source-1', label: 'PDF page 22', selector}]}]}} running={false} busy={false} writerAvailable={false} onSourceCitation={() => {}} onAnchor={() => {}} onNestedAction={() => {}} onThreadAction={() => {}} onReply={async () => true} replyDraft="" onReplyDraftChange={() => {}} annotationDraft="" onAnnotationDraftChange={() => {}} onSaveAnnotation={async () => true} onDismissAnnotationCandidate={async () => true} onPolishAnnotation={async () => true} onAddAnnotationToWriter={() => {}} onAddMessageToWriter={() => {}} onCopy={async () => {}}/>);
    expect(markup).toContain('PDF page 22');
    expect(markup).toContain('aria-label="PDF sources"');
    expect(markup).not.toContain('Add to Writer');
    expect(markup).toContain('Continue discussion');
  });

  it('offers PDF format for retained PDF sources and keeps editable uploads on HTML', () => {
    expect(supportsPdfReadingFormat('upload', {name: 'paper.pdf', type: 'application/pdf'})).toBe(true);
    expect(supportsPdfReadingFormat('arxiv', null)).toBe(true);
    expect(supportsPdfReadingFormat('url', null)).toBe(true);
    expect(supportsPdfReadingFormat('upload', {name: 'draft.docx', type: ''})).toBe(false);
  });
});
