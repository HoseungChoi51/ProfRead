import { access, rm } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import { cropReadingPdf, indexReadingPdf, prepareReadingPdf, type PdfReadingIndex } from './pdf-reading.js';
import { parseOcrTsv } from './pdf-reading-ocr.js';
import * as ocr from './pdf-reading-ocr.js';
import { scanZip } from './zip.js';

function fixturePdf(): Buffer {
  const objects: string[] = [], font = 11;
  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objects[2] = '<< /Type /Pages /Kids [3 0 R 5 0 R 7 0 R 9 0 R] /Count 4 >>';
  const text = ['Outside the article before.', 'Article native text with exact word spacing preserved.', '', 'Outside the article after.'];
  for (let index = 0; index < 4; index++) {
    const id = index * 2 + 3;
    objects[id] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /CropBox [20 30 592 762] ${index === 1 ? '/Rotate 90' : ''} /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${id + 1} 0 R >>`;
    const stream = text[index] ? `BT /F1 16 Tf 60 700 Td (${text[index]}) Tj ET\n0.9 0.1 0.1 rg 60 100 100 70 re f` : '0.1 0.2 0.8 rg 60 100 100 70 re f';
    objects[id + 1] = `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`;
  }
  objects[font] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';
  let source = '%PDF-1.7\n'; const offsets = [0];
  for (let id = 1; id <= font; id++) { offsets[id] = Buffer.byteLength(source); source += `${id} 0 obj\n${objects[id]}\nendobj\n`; }
  const xref = Buffer.byteLength(source);
  source += `xref\n0 ${font + 1}\n0000000000 65535 f \n`;
  for (let id = 1; id <= font; id++) source += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`;
  source += `trailer\n<< /Size ${font + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(source);
}
async function available(command: string): Promise<boolean> { try { await access(`/usr/bin/${command}`); return true; } catch { return false; } }
const hasPoppler = (await Promise.all(['pdfinfo', 'pdfseparate', 'pdfunite', 'pdftoppm', 'zip'].map(available))).every(Boolean);
const hasTesseract = await available('tesseract');

describe('OCR word index', () => {
  const header = 'level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext';
  it('preserves block order and UTF-16 offsets while mapping raster words back to PDF coordinates', () => {
    const tsv = `${header}\n5\t1\t1\t1\t1\t1\t10\t20\t40\t10\t98\tHello\n5\t1\t1\t1\t1\t2\t60\t20\t30\t10\t45\t수학\n5\t1\t2\t1\t1\t1\t120\t10\t40\t10\t90\tWorld\n`;
    const result = parseOcrTsv(tsv, 3, { width: 200, height: 400, viewportWidth: 100, viewportHeight: 200, toPdf: (x, y) => [20 + x, 230 - y] });
    expect(result.text).toBe('Hello 수학\nWorld');
    expect(result.items.map(item => result.text.slice(item.start, item.end))).toEqual(['Hello', '수학', 'World']);
    expect(result.items[0]?.quad).toEqual([25, 220, 45, 220, 45, 215, 25, 215]);
    expect(result.lowConfidenceWords).toBe(1);
    expect(result.items[2]?.line).toBe('2:1:1');
  });
  it('rejects corrupt OCR boxes and an unexpected TSV contract', () => {
    const mapping = { width: 100, height: 100, viewportWidth: 100, viewportHeight: 100, toPdf: (x: number, y: number) => [x, y] };
    expect(() => parseOcrTsv('text only', 1, mapping)).toThrow('word index');
    expect(() => parseOcrTsv(`${header}\n5\t1\t1\t1\t1\t1\t90\t0\t30\t10\t80\tOverflow`, 1, mapping)).toThrow('geometry');
  });
});

describe.runIf(hasPoppler)('PDF reader worker', () => {
  it('prepares only selected pages without OCR, preserving crop boxes, rotation and original page mapping', async () => {
    const source = fixturePdf(), original = Buffer.from(source), result = await prepareReadingPdf(source, { filename: 'Issue.pdf', pageStart: 2, pageEnd: 3 });
    try {
      const zip = await scanZip(result.archivePath, { collect: name => ['manifest.json', 'pdf-index.json', 'reading.pdf'].includes(name) });
      const index = JSON.parse(zip.collected.get('pdf-index.json')!.toString('utf8')) as PdfReadingIndex;
      expect(index).toMatchObject({ sourcePageCount: 4, pageCount: 2, selectedPageStart: 2, selectedPageEnd: 3, coordinateSpace: 'pdf-user-space' });
      expect(index.pages.map(page => [page.readerPage, page.sourcePage, page.status])).toEqual([[1, 2, 'pending'], [2, 3, 'pending']]);
      expect(index.pages[0]).toMatchObject({ view: [20, 30, 592, 762], rotation: 90, width: 572, height: 732 });
      expect(source.equals(original)).toBe(true);
      const indexed = await indexReadingPdf(zip.collected.get('reading.pdf')!, { pageStart: 1, pageEnd: 2, sourcePageStart: 2, ocr: 'off' });
      try {
        const indexedZip = await scanZip(indexed.archivePath, { collect: name => name === 'pdf-index.json' });
        const pages = (JSON.parse(indexedZip.collected.get('pdf-index.json')!.toString('utf8')) as PdfReadingIndex).pages;
        expect(pages[0]?.text).toContain('Article native text');
        expect(pages[0]?.text).not.toContain('Outside');
        expect(pages[1]).toMatchObject({ readerPage: 2, sourcePage: 3, status: 'image-only', text: '' });
        for (const item of pages[0]!.items) {
          expect(pages[0]!.text.slice(item.start, item.end)).toBe(item.str);
          expect(item.transform).toHaveLength(6); expect(item.quad).toHaveLength(8);
          expect(item.quad.every(Number.isFinite)).toBe(true);
        }
      } finally { await rm(indexed.root, { recursive: true, force: true }); }
    } finally { await rm(result.root, { recursive: true, force: true }); }
  }, 30_000);
  it('serves PDF-space crops and rejects out-of-page rectangles', async () => {
    const result = await cropReadingPdf(fixturePdf(), { page: 2, x: 60, y: 100, width: 100, height: 70 });
    try {
      const zip = await scanZip(result.archivePath, { collect: name => ['crop.png', 'crop.json'].includes(name) });
      const image = zip.collected.get('crop.png')!, crop = JSON.parse(zip.collected.get('crop.json')!.toString('utf8'));
      expect(image.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
      expect([image.readUInt32BE(16), image.readUInt32BE(20)]).toEqual([140, 200]);
      expect(crop.rect).toEqual([60, 100, 160, 170]);
    } finally { await rm(result.root, { recursive: true, force: true }); }
    await expect(cropReadingPdf(fixturePdf(), { page: 1, x: -1, y: 20, width: 10, height: 10 })).rejects.toThrow('within the PDF page');
  }, 30_000);
  it('rejects invalid ranges without publishing an incomplete source', async () => {
    await expect(prepareReadingPdf(fixturePdf(), { pageStart: 2, pageEnd: 5 })).rejects.toThrow('within 1–4');
    await expect(indexReadingPdf(fixturePdf(), { pageStart: 0, pageEnd: 2 })).rejects.toThrow('within 1–4');
    await expect(cropReadingPdf(fixturePdf(), { page: 1, x: Number.NaN, y: 30, width: 10, height: 10 })).rejects.toThrow('within the PDF page');
    await expect(cropReadingPdf(fixturePdf(), { page: 1, x: 20, y: 30, width: Number.POSITIVE_INFINITY, height: 10 })).rejects.toThrow('within the PDF page');
  });
  it('honors cancellation before processing and does not return a partial index', async () => {
    const controller = new AbortController(); controller.abort();
    await expect(indexReadingPdf(fixturePdf(), { pageStart: 1, pageEnd: 2, signal: controller.signal })).rejects.toThrow('cancelled');
  });
  it('retains native text when automatic OCR is less reliable, while a forced OCR remains explicit', async () => {
    const source = fixturePdf(), original = Buffer.from(source);
    const recognize = vi.spyOn(ocr, 'ocrPdfPage').mockImplementation(async (_input, _root, _page, metadata) => ({ ...metadata, status: 'ocr', text: 'Spurious OCR', transcript: 'Spurious OCR', readingOrder: ['ocr-0'],
      items: [{ id: 'ocr-0', itemIndex: 0, str: 'Spurious OCR', start: 0, end: 12, quad: [60, 720, 200, 720, 200, 700, 60, 700] }], ocr: { language: 'eng', meanConfidence: 29, lowConfidenceWords: 1 } }));
    try {
      for (const mode of ['auto', 'force'] as const) {
        const result = await indexReadingPdf(source, { pageStart: 1, pageEnd: 1, ocr: mode });
        try {
          const zip = await scanZip(result.archivePath, { collect: name => name === 'pdf-index.json' });
          const page = (JSON.parse(zip.collected.get('pdf-index.json')!.toString('utf8')) as PdfReadingIndex).pages[0]!;
          if (mode === 'auto') {
            expect(page.status).toBe('native'); expect(page.text).toContain('Outside the article before.'); expect(page.error).toContain('Low-confidence automatic OCR');
            expect(page.items.every(item => page.text.slice(item.start, item.end) === item.str)).toBe(true);
          } else { expect(page.status).toBe('ocr'); expect(page.text).toBe('Spurious OCR'); }
        } finally { await rm(result.root, { recursive: true, force: true }); }
      }
      expect(recognize).toHaveBeenCalledTimes(2); expect(source).toEqual(original);
    } finally { recognize.mockRestore(); }
  });
  it.runIf(hasTesseract)('runs local OCR with word boxes in PDF space', async () => {
    const result = await indexReadingPdf(fixturePdf(), { pageStart: 1, pageEnd: 1, ocr: 'force', language: 'eng' });
    try {
      const zip = await scanZip(result.archivePath, { collect: name => name === 'pdf-index.json' });
      const page = (JSON.parse(zip.collected.get('pdf-index.json')!.toString('utf8')) as PdfReadingIndex).pages[0]!;
      expect(page.status).toBe('ocr'); expect(page.text).toMatch(/Outside the article before/);
      expect(page.ocr?.meanConfidence).toBeGreaterThan(60);
      expect(page.items.every(item => item.quad.every(Number.isFinite))).toBe(true);
    } finally { await rm(result.root, { recursive: true, force: true }); }
  }, 120_000);
});
