import { createHash } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import type { PdfQuad, SourceCitation } from '@profread/shared';
import { config } from '../config.js';
import { extractVerifiedWorkerBundle } from '../academic/bundle.js';
import { cropReadingPdf } from '../academic/worker-client.js';
import { pdfPages, representation, validatePdfSelector } from './repository.js';
import type { PdfContextSnapshot } from './context.js';

export interface PdfEvidenceResult {
  images: Array<{ id: string; mimeType: 'image/png'; data: string; detail: 'high' }>;
  citations: SourceCitation[]; omittedPageNumbers: number[];
}
function fail(message: string, statusCode = 409): never { throw Object.assign(new Error(message), { statusCode }); }
function quadBounds(quads: PdfQuad[]): [number, number, number, number] {
  const xs = quads.flatMap(quad => [quad[0], quad[2], quad[4], quad[6]]), ys = quads.flatMap(quad => [quad[1], quad[3], quad[5], quad[7]]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}
type EvidenceOptions = { signal?: AbortSignal; maxImages?: number };
type EvidenceDependencies = { crop?: typeof cropReadingPdf };

/** Images are rendered from immutable server PDF bytes; callers never supply screenshots. */
export async function buildPdfEvidence(snapshot: PdfContextSnapshot, options: EvidenceOptions = {}, dependencies: EvidenceDependencies = {}): Promise<PdfEvidenceResult> {
  const source = representation(snapshot.representationId);
  if (source?.kind !== 'pdf' || source.document_version_id !== snapshot.documentVersionId || source.source_hash !== snapshot.sourceHash || source.pdf_hash !== snapshot.pdfHash || !source.pdf_path || snapshot.extractionRevision > source.extraction_revision) fail('PDF evidence source no longer matches this conversation');
  const storageRoot = await realpath(config.dataDir), path = await realpath(source.pdf_path);
  if (!path.startsWith(resolve(storageRoot) + sep)) fail('PDF evidence source lies outside application storage');
  const size = (await stat(path)).size;
  if (size > config.limits.workerResponseBytes || size < 8) fail('PDF evidence source has an invalid size');
  const bytes = await readFile(path);
  if (bytes.subarray(0, 5).toString('ascii') !== '%PDF-' || createHash('sha256').update(bytes).digest('hex') !== snapshot.pdfHash) fail('Immutable PDF evidence failed its integrity check');
  const maximum = Math.min(4, Math.max(1, Math.floor(Number.isFinite(options.maxImages) ? options.maxImages! : 4)));
  const pages = new Map(pdfPages(source.id, snapshot.extractionRevision).map(page => [page.page, page]));
  const targets: Array<{ citation: SourceCitation; page: number; quads: PdfQuad[] }> = [];
  for (const citation of snapshot.evidenceTargets) {
    if (citation.selector.representationId !== source.id || citation.selector.sourceHash !== source.source_hash) fail('PDF evidence target belongs to another source');
    validatePdfSelector(snapshot.documentVersionId, citation.selector);
    for (const segment of citation.selector.segments) targets.push({ citation, page: segment.page, quads: segment.quads });
  }
  const result: PdfEvidenceResult = { images: [], citations: [], omittedPageNumbers: [...new Set(targets.slice(maximum).map(target => pages.get(target.page)?.sourcePage).filter((page): page is number => page !== undefined))] };
  const directory = await mkdtemp(join(tmpdir(), 'profread-pdf-evidence-'));
  try {
    for (const [index, target] of targets.slice(0, maximum).entries()) {
      options.signal?.throwIfAborted(); const page = pages.get(target.page); if (!page) fail('PDF evidence page is missing');
      const raw = quadBounds(target.quads), [x0, y0, x1, y1] = page.view;
      // Text selections receive a small context margin; complete-page citations stay in bounds.
      const margin = target.citation.selector.kind === 'pdf-text' ? 6 : 0;
      const rect = [Math.max(x0, raw[0] - margin), Math.max(y0, raw[1] - margin), Math.min(x1, raw[2] + margin), Math.min(y1, raw[3] + margin)];
      if (rect.some(value => !Number.isFinite(value)) || rect[2]! <= rect[0]! || rect[3]! <= rect[1]!) fail('PDF evidence target has invalid geometry');
      const archive = await (dependencies.crop ?? cropReadingPdf)(path, { page: page.page, x: rect[0]!, y: rect[1]!, width: rect[2]! - rect[0]!, height: rect[3]! - rect[1]! }, options.signal);
      const bundle = await extractVerifiedWorkerBundle(archive, join(directory, String(index)), snapshot.pdfHash, 'pdf-crop');
      const imageFile = bundle.files.find(file => file.path === 'crop.png'), metadataFile = bundle.files.find(file => file.path === 'crop.json');
      if (!imageFile || !metadataFile || imageFile.bytes > 16 * 1024 * 1024) fail('PDF worker returned incomplete crop evidence');
      const metadata = JSON.parse(await readFile(metadataFile.storagePath, 'utf8')) as { readerPage?: number; rect?: number[]; width?: number; height?: number };
      if (metadata.readerPage !== page.page || !Array.isArray(metadata.rect) || metadata.rect.length !== 4 || metadata.rect.some((value, coordinate) => !Number.isFinite(value) || Math.abs(value - rect[coordinate]!) > 0.01)) fail('PDF crop evidence does not match the requested source region');
      const image = await readFile(imageFile.storagePath);
      if (image.length < 24 || image.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' || image.readUInt32BE(16) < 1 || image.readUInt32BE(20) < 1 || image.readUInt32BE(16) > 3001 || image.readUInt32BE(20) > 3001) fail('PDF crop is not a valid bounded image');
      result.images.push({ id: `${target.citation.id}-image-${index + 1}`, mimeType: 'image/png', data: image.toString('base64'), detail: 'high' });
      if (!result.citations.some(item => item.id === target.citation.id)) result.citations.push(target.citation);
    }
    return result;
  } finally { await rm(directory, { recursive: true, force: true }); }
}
