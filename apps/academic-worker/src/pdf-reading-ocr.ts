import { readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { PDFPageProxy } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { WorkerError } from './errors.js';
import { runCommand } from './process.js';
import type { PdfQuad, PdfReadingPage, PdfTextItem } from './pdf-reading.js';

export type OcrLanguage = 'eng' | 'eng+kor';
export type OcrMode = 'auto' | 'force' | 'off';
type RasterMapping = { width: number; height: number; viewportWidth: number; viewportHeight: number; toPdf: (x: number, y: number) => number[] };

/** TSV rows retain Tesseract's block/paragraph/line reading order, never global y/x sorting. */
export function parseOcrTsv(tsv: string, readerPage: number, mapping: RasterMapping): { text: string; items: PdfTextItem[]; meanConfidence: number; lowConfidenceWords: number } {
  if (Buffer.byteLength(tsv) > 16 * 1024 * 1024) throw new WorkerError('ocr_text_limit', 'OCR page text exceeds the indexing limit.', 422);
  const lines = tsv.split(/\r?\n/), headers = lines.shift()?.split('\t') ?? [];
  if (headers.join('\t') !== 'level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext') throw new WorkerError('invalid_ocr_output', 'OCR did not produce the expected word index.', 422);
  const items: PdfTextItem[] = []; let text = '', previousLine = '', totalConfidence = 0, lowConfidenceWords = 0;
  for (const line of lines) {
    if (!line.trim()) continue;
    const cells = line.split('\t');
    if (cells[0] !== '5') continue;
    const str = cells.slice(11).join('\t'); if (!str.trim()) continue;
    const [left, top, width, height, confidence] = cells.slice(6, 11).map(Number);
    if ([left, top, width, height, confidence].some(value => value === undefined || !Number.isFinite(value)) || left! < 0 || top! < 0 || width! <= 0 || height! <= 0 || left! + width! > mapping.width + 1 || top! + height! > mapping.height + 1 || confidence! < 0 || confidence! > 100) throw new WorkerError('invalid_ocr_output', 'OCR produced invalid word geometry.', 422);
    if (items.length >= 30_000 || text.length + str.length > 1_000_000) throw new WorkerError('ocr_text_limit', 'OCR page text exceeds the indexing limit.', 422);
    const lineId = `${cells[2]}:${cells[3]}:${cells[4]}`;
    if (items.length) text += lineId === previousLine ? ' ' : '\n';
    const start = text.length; text += str;
    const point = (x: number, y: number) => mapping.toPdf(x / mapping.width * mapping.viewportWidth, y / mapping.height * mapping.viewportHeight);
    const topLeft = point(left!, top!), topRight = point(left! + width!, top!), bottomRight = point(left! + width!, top! + height!), bottomLeft = point(left!, top! + height!);
    items.push({ id: `p${readerPage}-o${items.length}`, itemIndex: items.length, start, end: text.length, str,
      quad: [...topLeft, ...topRight, ...bottomRight, ...bottomLeft] as PdfQuad,
      confidence: confidence!, block: Number(cells[2]), line: lineId });
    previousLine = lineId; totalConfidence += confidence!; if (confidence! < 60) lowConfidenceWords++;
  }
  return { text, items, meanConfidence: items.length ? totalConfidence / items.length : 0, lowConfidenceWords };
}

export async function ocrPdfPage(input: string, root: string, page: PDFPageProxy, metadata: PdfReadingPage, language: OcrLanguage, signal?: AbortSignal): Promise<PdfReadingPage> {
  if (!['eng', 'eng+kor'].includes(language)) throw new WorkerError('invalid_ocr_language', 'Choose English or English and Korean for OCR.', 422);
  const base = page.getViewport({ scale: 1 }), scale = Math.min(300 / 72, 4200 / Math.max(base.width, base.height)), viewport = page.getViewport({ scale });
  const prefix = join(root, `ocr-page-${metadata.readerPage}`), image = `${prefix}.png`, tsvPath = `${prefix}.tsv`;
  try {
    await runCommand('pdftoppm', ['-singlefile', '-png', '-cropbox', '-f', String(metadata.readerPage), '-l', String(metadata.readerPage), '-r', String(scale * 72), input, prefix], { cwd: root, timeoutMs: 45_000, signal });
    if ((await stat(image)).size > 64 * 1024 * 1024) throw new WorkerError('output_too_large', 'OCR page image exceeds the image limit.', 422);
    const png = await readFile(image);
    if (png.length < 24 || png.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') throw new WorkerError('invalid_render_output', 'OCR page raster is invalid.', 422);
    const width = png.readUInt32BE(16), height = png.readUInt32BE(20);
    if (!width || !height || Math.max(width, height) > 4201) throw new WorkerError('invalid_render_output', 'OCR page raster exceeds its dimensions limit.', 422);
    const mapping = {
      width, height, viewportWidth: viewport.width, viewportHeight: viewport.height,
      toPdf: (x: number, y: number) => viewport.convertToPdfPoint(x, y),
    };
    const recognize = async (segmentation: '3' | '6') => {
      await runCommand('tesseract', [image, prefix, '-l', language === 'eng+kor' ? 'kor+eng' : 'eng', '--psm', segmentation, 'tsv'], { cwd: root, timeoutMs: 45_000, signal });
      if ((await stat(tsvPath)).size > 16 * 1024 * 1024) throw new WorkerError('ocr_text_limit', 'OCR page text exceeds the indexing limit.', 422);
      return parseOcrTsv(await readFile(tsvPath, 'utf8'), metadata.readerPage, mapping);
    };
    let result = await recognize('3');
    if (!result.items.length || result.meanConfidence < 65) {
      const fallback = await recognize('6');
      if (fallback.items.length && (!result.items.length || fallback.meanConfidence > result.meanConfidence)) result = fallback;
    }
    return { ...metadata, status: result.items.length ? 'ocr' : 'image-only', text: result.text, items: result.items,
      transcript: result.text.normalize('NFKC'), readingOrder: result.items.map(item => item.id),
      ocr: { language, meanConfidence: result.meanConfidence, lowConfidenceWords: result.lowConfidenceWords } };
  } finally { await Promise.all([rm(image, { force: true }), rm(tsvPath, { force: true })]); }
}
