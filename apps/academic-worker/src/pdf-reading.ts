import { copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDocument, type PDFDocumentProxy, type PDFPageProxy } from 'pdfjs-dist/legacy/build/pdf.mjs';

import type { OperationResult } from './convert.js';
import { WorkerError } from './errors.js';
import { assertFileWithinWorkerOutputLimit, bundleFiles, createZip, sha256Bytes, workerOutputLimit, writeJson } from './files.js';
import { hasPdfHeader } from './pdf.js';
import { parsePdfInfo, pdfConversionInputLimit, readingBlocks, repairTrackedLetters } from './pdf-convert.js';
import { runCommand } from './process.js';
import { ocrPdfPage, type OcrLanguage, type OcrMode } from './pdf-reading-ocr.js';

export type PdfRect = [number, number, number, number];
export type PdfQuad = [number, number, number, number, number, number, number, number];
export type PdfTextItem = {
  id: string; itemIndex: number; start: number; end: number; str: string; quad: PdfQuad;
  transform?: number[]; width?: number; height?: number; fontName?: string; dir?: string; hasEOL?: boolean;
  confidence?: number; block?: number; line?: string;
};
export type PdfReadingPage = {
  readerPage: number; sourcePage: number; view: PdfRect; width: number; height: number; rotation: number; label?: string;
  status: 'pending' | 'native' | 'ocr' | 'image-only' | 'failed'; text: string; items: PdfTextItem[];
  transcript: string; readingOrder: string[];
  error?: string; ocr?: { language: OcrLanguage; meanConfidence: number; lowConfidenceWords: number };
};
export type PdfReadingIndex = {
  schemaVersion: 1; sourceHash: string; derivativeHash: string; sourcePageCount: number; pageCount: number;
  selectedPageStart: number; selectedPageEnd: number; coordinateSpace: 'pdf-user-space'; pages: PdfReadingPage[];
};
export const pdfIndexBatchLimit = 4;
const pdfPackageRoot = dirname(fileURLToPath(import.meta.resolve('pdfjs-dist/package.json')));

export function assertPdfInput(body: Buffer): void {
  if (body.byteLength > pdfConversionInputLimit) throw new WorkerError('body_too_large', 'PDF exceeds the 100 MiB source limit.', 413);
  if (!hasPdfHeader(body)) throw new WorkerError('invalid_pdf', 'The source does not start with a PDF header.', 422);
}
export function assertPageRange(start: number, end: number, total: number, maximum = 100): void {
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start || end > total || end - start + 1 > maximum) {
    throw new WorkerError('invalid_page_range', `Choose at most ${maximum} PDF pages within 1–${total}.`, 422);
  }
}
export async function withReadingPdf<T>(body: Buffer, signal: AbortSignal | undefined, callback: (pdf: PDFDocumentProxy) => Promise<T>): Promise<T> {
  assertPdfInput(body);
  const loading = getDocument({ data: new Uint8Array(body), useWorkerFetch: false,
    cMapUrl: join(pdfPackageRoot, 'cmaps') + '/', cMapPacked: true,
    standardFontDataUrl: join(pdfPackageRoot, 'standard_fonts') + '/',
    wasmUrl: join(pdfPackageRoot, 'wasm') + '/', stopAtErrors: true });
  const abort = () => { void loading.destroy(); };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    signal?.throwIfAborted();
    const pdf = await loading.promise;
    if (pdf.numPages > 100) throw new WorkerError('pdf_page_limit_exceeded', 'PDF reading is limited to 100 source pages and will not truncate the source.', 422);
    return await callback(pdf);
  } catch (error) {
    if (signal?.aborted) throw new WorkerError('request_aborted', 'PDF processing was cancelled.', 499);
    if (error instanceof Error && error.name === 'PasswordException') throw new WorkerError('encrypted_pdf', 'Password-protected PDFs are not supported.', 422);
    throw error;
  } finally { signal?.removeEventListener('abort', abort); await loading.destroy(); }
}
export function readingPageMetadata(page: PDFPageProxy, readerPage: number, sourcePage: number): PdfReadingPage {
  const view = page.view as PdfRect;
  if (view.length !== 4 || view.some(value => !Number.isFinite(value)) || view[2] <= view[0] || view[3] <= view[1]) throw new WorkerError('invalid_pdf_geometry', 'PDF page has invalid dimensions.', 422);
  return { readerPage, sourcePage, view: [...view], width: view[2] - view[0], height: view[3] - view[1], rotation: page.rotate, status: 'pending', text: '', items: [], transcript: '', readingOrder: [] };
}

/** Preserve exact PDF.js strings/indices; separators are explicit parts of the page transcript. */
export async function extractNativeReadingPage(page: PDFPageProxy, readerPage: number, sourcePage: number): Promise<PdfReadingPage> {
  const output = readingPageMetadata(page, readerPage, sourcePage), content = await page.getTextContent({ disableNormalization: true });
  for (let itemIndex = 0; itemIndex < content.items.length; itemIndex++) {
    const item = content.items[itemIndex]!;
    if (!('str' in item) || !item.str) continue;
    if (output.items.length >= 30_000 || output.text.length + item.str.length > 1_000_000) throw new WorkerError('pdf_text_limit', 'PDF page text exceeds the indexing limit.', 422);
    const [a = 1, b = 0, c = 0, d = 1, e = 0, f = 0] = item.transform;
    const along = Math.hypot(a, b) || 1, upward = Math.hypot(c, d) || 1;
    const dx = a / along * item.width, dy = b / along * item.width;
    const height = item.height || upward, ascent = content.styles[item.fontName]?.ascent ?? 0.8;
    const topX = e + c / upward * height * ascent, topY = f + d / upward * height * ascent;
    const bottomX = topX - c / upward * height, bottomY = topY - d / upward * height;
    const start = output.text.length;
    output.text += item.str;
    output.items.push({ id: `p${readerPage}-t${itemIndex}`, itemIndex, start, end: output.text.length, str: item.str,
      quad: [topX, topY, topX + dx, topY + dy, bottomX + dx, bottomY + dy, bottomX, bottomY],
      transform: [...item.transform], width: item.width, height: item.height, fontName: item.fontName, dir: item.dir, hasEOL: item.hasEOL });
    output.text += item.hasEOL ? '\n' : ' ';
  }
  output.status = output.items.length ? 'native' : 'image-only';
  const viewport = page.getViewport({ scale: 1 }), byId = new Map(output.items.map(item => [item.id, item]));
  const spans = output.items.filter(item => item.str.trim()).map(item => {
    const points = [0, 2, 4, 6].map(index => viewport.convertToViewportPoint(item.quad[index]!, item.quad[index + 1]!));
    const xs = points.map(point => point[0] as number), ys = points.map(point => point[1] as number);
    return { id: item.id, page: readerPage, left: Math.min(...xs), top: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs),
      height: Math.max(...ys) - Math.min(...ys), fontId: item.fontName ?? '', fontSize: item.height ?? 12, text: item.str };
  });
  const ordered = readingBlocks({ number: readerPage, width: viewport.width, height: viewport.height, spans, images: [] });
  output.readingOrder = ordered.flatMap(block => block.spanIds);
  output.transcript = ordered.map(block => repairTrackedLetters(block.spanIds.map(id => byId.get(id)!.str).join(' ')).replace(/\s+/g, ' ').trim()).join('\n');
  return output;
}
export function needsPageOcr(page: PdfReadingPage): boolean {
  const text = page.text.trim(), meaningful = text.replace(/\s/g, '').length;
  const bad = [...text].filter(character => character === '\uFFFD' || character.charCodeAt(0) < 32 && ![9, 10, 13].includes(character.charCodeAt(0))).length;
  const words = text.match(/\p{L}+/gu) ?? [], isolatedLetters = words.filter(word => word.length === 1).length;
  return meaningful < 40 || bad > meaningful * 0.03 || words.length > 30 && isolatedLetters / words.length > 0.4;
}
async function readingBundle(root: string, bundle: string, body: Buffer, operation: string, output: Record<string, unknown>, signal?: AbortSignal): Promise<OperationResult> {
  const files = await bundleFiles(bundle);
  await writeJson(join(bundle, 'manifest.json'), { schemaVersion: 1, operation, source: { kind: 'pdf', sha256: sha256Bytes(body) },
    output, converter: { selected: 'pdfjs-poppler-reading', revision: '1', pdfjsVersion: '6.3.289' }, warnings: [], files });
  const archivePath = join(root, 'result.zip'); await createZip(bundle, archivePath, signal);
  await assertFileWithinWorkerOutputLimit(archivePath, 'PDF reading bundle exceeds the response limit.');
  return { root, archivePath, downloadName: `profread-${operation}.zip` };
}

export async function prepareReadingPdf(body: Buffer, options: { filename?: string; pageStart?: number; pageEnd?: number; signal?: AbortSignal } = {}): Promise<OperationResult> {
  assertPdfInput(body);
  const root = await mkdtemp(join(tmpdir(), 'profread-pdf-prepare-')), input = join(root, 'source.pdf'), bundle = join(root, 'bundle');
  await mkdir(bundle); await writeFile(input, body, { mode: 0o600 });
  try {
    const info = parsePdfInfo((await runCommand('pdfinfo', [input], { cwd: root, timeoutMs: 30_000, signal: options.signal })).stdout);
    const labels = await withReadingPdf(body, options.signal, pdf => pdf.getPageLabels());
    const start = options.pageStart ?? 1, end = options.pageEnd ?? info.pages;
    assertPageRange(start, end, info.pages);
    const derivative = join(bundle, 'reading.pdf');
    if (start === 1 && end === info.pages) await copyFile(input, derivative);
    else {
      const selected = Array.from({ length: end - start + 1 }, (_, index) => join(root, `page-${start + index}.pdf`));
      let extractedBytes = 0;
      for (let number = start; number <= end; number++) {
        await runCommand('pdfseparate', ['-f', String(number), '-l', String(number), input, join(root, 'page-%d.pdf')], { cwd: root, timeoutMs: 30_000, signal: options.signal });
        extractedBytes += (await stat(join(root, `page-${number}.pdf`))).size;
        if (extractedBytes > workerOutputLimit()) throw new WorkerError('output_too_large', 'Selected-page extraction exceeds the working size limit.', 422);
      }
      await runCommand('pdfunite', [...selected, derivative], { cwd: root, timeoutMs: 120_000, signal: options.signal });
    }
    await assertFileWithinWorkerOutputLimit(derivative);
    const derivativeBytes = await readFile(derivative), pages = await withReadingPdf(derivativeBytes, options.signal, async pdf => {
      if (pdf.numPages !== end - start + 1) throw new WorkerError('incomplete_pdf_extraction', 'Selected-page PDF has an unexpected page count.', 422);
      const output: PdfReadingPage[] = [];
      for (let number = 1; number <= pdf.numPages; number++) { options.signal?.throwIfAborted(); const page = await pdf.getPage(number), metadata = readingPageMetadata(page, number, start + number - 1), label = labels?.[start + number - 2]; if (label) metadata.label = label; output.push(metadata); page.cleanup(); }
      return output;
    });
    const index: PdfReadingIndex = { schemaVersion: 1, sourceHash: sha256Bytes(body), derivativeHash: sha256Bytes(derivativeBytes), sourcePageCount: info.pages,
      pageCount: pages.length, selectedPageStart: start, selectedPageEnd: end, coordinateSpace: 'pdf-user-space', pages };
    await writeJson(join(bundle, 'pdf-index.json'), index);
    return await readingBundle(root, bundle, body, 'pdf-prepare', { entryPath: 'pdf-index.json', pdfPath: 'reading.pdf', title: basename(options.filename ?? 'Imported PDF').replace(/\.pdf$/i, ''), pageCount: pages.length }, options.signal);
  } catch (error) { await rm(root, { recursive: true, force: true }); throw error; }
}

export async function indexReadingPdf(body: Buffer, options: { pageStart: number; pageEnd: number; sourcePageStart?: number; ocr?: OcrMode; language?: OcrLanguage; signal?: AbortSignal }): Promise<OperationResult> {
  assertPdfInput(body);
  const root = await mkdtemp(join(tmpdir(), 'profread-pdf-index-')), input = join(root, 'source.pdf'), bundle = join(root, 'bundle');
  await mkdir(bundle); await writeFile(input, body, { mode: 0o600 });
  try {
    const originalStart = options.sourcePageStart ?? 1;
    if (!Number.isInteger(originalStart) || originalStart < 1 || originalStart > 100) throw new WorkerError('invalid_page_range', 'Source page start must be within 1–100.', 422);
    const pages = await withReadingPdf(body, options.signal, async pdf => {
      assertPageRange(options.pageStart, options.pageEnd, pdf.numPages, pdfIndexBatchLimit);
      if (originalStart + pdf.numPages - 1 > 100) throw new WorkerError('invalid_page_range', 'Original page mapping exceeds 100 source pages.', 422);
      const output: PdfReadingPage[] = [];
      for (let number = options.pageStart; number <= options.pageEnd; number++) {
        options.signal?.throwIfAborted(); const page = await pdf.getPage(number), metadata = readingPageMetadata(page, number, originalStart + number - 1);
        try {
          let indexed = await extractNativeReadingPage(page, number, metadata.sourcePage);
          if (options.ocr === 'force' || options.ocr !== 'off' && needsPageOcr(indexed)) {
            try {
              const recognized = await ocrPdfPage(input, root, page, metadata, options.language ?? 'eng', options.signal);
              if (options.ocr !== 'force' && indexed.items.length && recognized.items.length && (recognized.ocr?.meanConfidence ?? 0) < 70) {
                indexed = { ...indexed, error: 'Low-confidence automatic OCR; native text was retained. Verify the page image before relying on extracted text.' };
              } else if (recognized.items.length || !indexed.items.length || options.ocr === 'force') indexed = recognized;
            }
            catch (error) { if (options.signal?.aborted) throw error; indexed = { ...indexed, error: `OCR failed: ${error instanceof Error ? error.message : String(error)}`, ...(indexed.status === 'image-only' ? { status: 'failed' as const } : {}) }; }
          }
          output.push(indexed);
        } catch (error) { if (options.signal?.aborted) throw error; output.push({ ...metadata, status: 'failed', error: error instanceof Error ? error.message : String(error) }); }
        finally { page.cleanup(); }
      }
      return { pages: output, pageCount: pdf.numPages };
    });
    const index: PdfReadingIndex = { schemaVersion: 1, sourceHash: sha256Bytes(body), derivativeHash: sha256Bytes(body), sourcePageCount: originalStart + pages.pageCount - 1,
      pageCount: pages.pageCount, selectedPageStart: originalStart, selectedPageEnd: originalStart + pages.pageCount - 1, coordinateSpace: 'pdf-user-space', pages: pages.pages };
    await writeJson(join(bundle, 'pdf-index.json'), index);
    return await readingBundle(root, bundle, body, 'pdf-index', { entryPath: 'pdf-index.json', pageCount: pages.pageCount }, options.signal);
  } catch (error) { await rm(root, { recursive: true, force: true }); throw error; }
}

export async function cropReadingPdf(body: Buffer, options: { page: number; x: number; y: number; width: number; height: number; signal?: AbortSignal }): Promise<OperationResult> {
  assertPdfInput(body);
  const root = await mkdtemp(join(tmpdir(), 'profread-pdf-crop-')), input = join(root, 'source.pdf'), bundle = join(root, 'bundle');
  await mkdir(bundle); await writeFile(input, body, { mode: 0o600 });
  try {
    const crop = await withReadingPdf(body, options.signal, async pdf => {
      assertPageRange(options.page, options.page, pdf.numPages);
      const page = await pdf.getPage(options.page), view = page.view, rect: PdfRect = [options.x, options.y, options.x + options.width, options.y + options.height];
      if (rect.some(value => !Number.isFinite(value)) || options.width <= 0 || options.height <= 0 || rect[0] < view[0]! || rect[1] < view[1]! || rect[2] > view[2]! || rect[3] > view[3]!) throw new WorkerError('invalid_pdf_crop', 'Crop rectangle must lie within the PDF page.', 422);
      const base = page.getViewport({ scale: 1 }), scale = Math.min(2, 3000 / Math.max(base.width, base.height)), viewport = page.getViewport({ scale });
      const corners = [...viewport.convertToViewportPoint(rect[0], rect[1]), ...viewport.convertToViewportPoint(rect[2], rect[3])], left = Math.max(0, Math.floor(Math.min(corners[0]!, corners[2]!))), top = Math.max(0, Math.floor(Math.min(corners[1]!, corners[3]!)));
      const width = Math.max(1, Math.ceil(Math.max(corners[0]!, corners[2]!)) - left), height = Math.max(1, Math.ceil(Math.max(corners[1]!, corners[3]!)) - top);
      await runCommand('pdftoppm', ['-singlefile', '-png', '-cropbox', '-f', String(options.page), '-l', String(options.page), '-r', String(scale * 72), '-x', String(left), '-y', String(top), '-W', String(width), '-H', String(height), input, join(bundle, 'crop')], { cwd: root, timeoutMs: 60_000, signal: options.signal });
      if ((await stat(join(bundle, 'crop.png'))).size > 32 * 1024 * 1024) throw new WorkerError('output_too_large', 'PDF crop exceeds the image limit.', 422);
      return { readerPage: options.page, rect, width, height, rasterTransform: viewport.transform };
    });
    await writeJson(join(bundle, 'crop.json'), crop);
    return await readingBundle(root, bundle, body, 'pdf-crop', { entryPath: 'crop.json', imagePath: 'crop.png', ...crop }, options.signal);
  } catch (error) { await rm(root, { recursive: true, force: true }); throw error; }
}
