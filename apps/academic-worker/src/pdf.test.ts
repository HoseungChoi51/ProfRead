import { access, rm } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

import { hasPdfHeader, pdfPageLimit, renderPdf } from './pdf.js';
import { scanZip } from './zip.js';

function fixturePdf(): Buffer {
  const parts = ['%PDF-1.4\n']; const offsets: number[] = [0];
  const add = (id: number, value: string) => { offsets[id] = Buffer.byteLength(parts.join('')); parts.push(`${id} 0 obj\n${value}\nendobj\n`); };
  add(1, '<< /Type /Catalog /Pages 2 0 R >>');
  add(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
  add(3, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 120] /Resources << >> /Contents 4 0 R >>');
  const stream = '1 0 0 rg\n20 20 160 80 re f\n'; add(4, `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`);
  const xref = Buffer.byteLength(parts.join('')); parts.push('xref\n0 5\n0000000000 65535 f \n');
  for (let id = 1; id <= 4; id++) parts.push(`${String(offsets[id]).padStart(10, '0')} 00000 n \n`);
  parts.push(`trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`); return Buffer.from(parts.join(''));
}

describe('PDF reference bounds', () => {
  it('validates the magic header and clamps pages', () => {
    expect(hasPdfHeader(fixturePdf())).toBe(true); expect(hasPdfHeader(Buffer.from('<html>'))).toBe(false);
    expect(pdfPageLimit(-2)).toBe(1); expect(pdfPageLimit(12.9)).toBe(12); expect(pdfPageLimit(200)).toBe(60); expect(pdfPageLimit(Number.NaN)).toBe(60);
  });
});

let hasPoppler = true; try { await access('/usr/bin/pdftoppm'); } catch { hasPoppler = false; }
describe.runIf(hasPoppler)('PDF reference renderer', () => {
  it('creates a bounded PNG evidence bundle', async () => {
    const result = await renderPdf(fixturePdf(), { filename: '../fixture.pdf', pages: 2 });
    try {
      const zip = await scanZip(result.archivePath, { collect: name => name === 'manifest.json' || name === 'reference/page-001.png' });
      const manifest = JSON.parse(zip.collected.get('manifest.json')!.toString('utf8')) as any;
      expect(manifest).toMatchObject({ operation: 'render', source: { kind: 'pdf', filename: 'fixture.pdf', pages: 1 }, renderer: { name: 'pdftoppm', pageLimit: 2 } });
      expect(manifest.output.pages).toEqual([expect.objectContaining({ page: 1, path: 'reference/page-001.png' })]);
      expect(zip.collected.get('reference/page-001.png')!.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
    } finally { await rm(result.root, { recursive: true, force: true }); }
  }, 30_000);
});
