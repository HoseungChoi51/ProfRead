import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { zipSync } from 'fflate';
import { describe, expect, it, vi } from 'vitest';
import type { PdfPage } from '@profread/shared';
import { config } from '../config.js';
import { db, now } from '../db/index.js';
import { buildPdfContext } from './context.js';
import { buildPdfEvidence } from './evidence.js';
import { createPdfAnchor, savePdfPages } from './repository.js';

const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
async function fixture() {
  const documentId = randomUUID(), versionId = randomUUID(), representationId = randomUUID(), time = now(), bytes = Buffer.from('%PDF-1.7\nsource evidence');
  const directory = join(config.dataDir, 'pdf', representationId), path = join(directory, 'reading.pdf'); await mkdir(directory, { recursive: true }); await writeFile(path, bytes);
  db.prepare('INSERT INTO documents(id,title,created_at)VALUES(?,?,?)').run(documentId, 'PDF evidence', time);
  db.prepare("INSERT INTO document_versions(id,document_id,content_hash,source_name,entry_path,sanitized_html_path,canonical_text,token_estimate,version,created_at)VALUES(?,?,?,?,NULL,NULL,'',0,1,?)").run(versionId, documentId, randomUUID(), 'source.pdf', time);
  db.prepare("INSERT INTO document_representations(id,document_version_id,kind,status,source_hash,pdf_hash,pdf_path,source_page_start,source_page_end,page_count,created_at,updated_at)VALUES(?,?,'pdf','indexing',?,?,?,22,23,2,?,?)").run(representationId, versionId, hash(bytes), hash(bytes), path, time, time);
  const pages: PdfPage[] = [1, 2].map(page => ({ page, sourcePage: page + 21, view: [0, 0, 600, 800], rotation: 0, text: '', textStatus: 'pending', items: [] }));
  const revision = savePdfPages(representationId, pages);
  const anchor = createPdfAnchor(versionId, { kind: 'pdf-region', representationId, sourceHash: hash(bytes), extractionRevision: revision, exact: '', segments: [{ page: 1, quads: [[50, 700, 150, 700, 150, 600, 50, 600]] }] });
  const input = { documentVersionId: versionId, representationId, profile: 'vision', query: 'What does this diagram mean?', anchorId: anchor.id };
  return { path, hash: hash(bytes), input };
}
function cropStub(sourceHash: string, wrongRegion = false) {
  return vi.fn(async (_path: string, options: { page: number; x: number; y: number; width: number; height: number }) => {
    const crop = Buffer.from(JSON.stringify({ readerPage: options.page, rect: [options.x + (wrongRegion ? 1 : 0), options.y, options.x + options.width, options.y + options.height], width: 1, height: 1 }));
    const manifest = Buffer.from(JSON.stringify({ schemaVersion: 1, operation: 'pdf-crop', source: { kind: 'pdf', sha256: sourceHash }, output: { entryPath: 'crop.json', imagePath: 'crop.png' }, warnings: [], files: [{ path: 'crop.json', bytes: crop.length, sha256: hash(crop) }, { path: 'crop.png', bytes: png.length, sha256: hash(png) }] }));
    return Buffer.from(zipSync({ 'manifest.json': manifest, 'crop.json': crop, 'crop.png': png }));
  });
}

describe('saved PDF source evidence', () => {
  it('renders pending-page region questions and later followups from stored selectors', async () => {
    const source = await fixture(), crop = cropStub(source.hash);
    for (let turn = 0; turn < 2; turn++) {
      const snapshot = buildPdfContext(source.input), evidence = await buildPdfEvidence(snapshot, { maxImages: 1 }, { crop });
      expect(evidence.images).toHaveLength(1); expect(evidence.images[0]?.mimeType).toBe('image/png');
      expect(evidence.citations[0]?.id).toBe('pdf-selection'); expect(evidence.omittedPageNumbers).toContain(23);
      expect(crop).toHaveBeenLastCalledWith(source.path, { page: 1, x: 50, y: 600, width: 100, height: 100 }, undefined);
    }
    expect(crop).toHaveBeenCalledTimes(2);
  });
  it('rejects crop bundles that are signed for another PDF or another source rectangle', async () => {
    const source = await fixture(), snapshot = buildPdfContext(source.input);
    await expect(buildPdfEvidence(snapshot, { maxImages: 1 }, { crop: cropStub('a'.repeat(64)) })).rejects.toThrow('source hash');
    await expect(buildPdfEvidence(snapshot, { maxImages: 1 }, { crop: cropStub(source.hash, true) })).rejects.toThrow('requested source region');
  });
  it('detects altered source bytes before requesting any crop', async () => {
    const source = await fixture(), snapshot = buildPdfContext(source.input), crop = cropStub(source.hash);
    await writeFile(source.path, '%PDF-1.7\nchanged source bytes');
    await expect(buildPdfEvidence(snapshot, {}, { crop })).rejects.toThrow('integrity check');
    expect(crop).not.toHaveBeenCalled();
  });
});
