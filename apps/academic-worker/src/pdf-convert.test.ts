import { access, rm } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { convertPdf, parsePdfInfo, parsePdfLayoutXml, pdfConversionPageLimit, pdfTitleCandidate, readingBlocks, renderReadingHtml } from './pdf-convert.js';
import { scanZip } from './zip.js';

const layoutXml = `<?xml version="1.0" encoding="UTF-8"?>
<pdf2xml>
  <fontspec id="0" size="24" family="Helvetica"/>
  <fontspec id="1" size="12" family="Times"/>
  <page number="1" width="600" height="800">
    <text top="30" left="60" width="480" height="28" font="0">A Complete &amp; Reproducible Paper</text>
    <text top="100" left="50" width="220" height="14" font="1">Left one</text>
    <text top="120" left="50" width="220" height="14" font="1">Left two</text>
    <text top="140" left="50" width="220" height="14" font="1">Left three</text>
    <text top="160" left="50" width="220" height="14" font="1">Left four</text>
    <text top="100" left="330" width="220" height="14" font="1">Right one</text>
    <text top="120" left="330" width="220" height="14" font="1">Right two</text>
    <text top="140" left="330" width="220" height="14" font="1">Right three</text>
    <text top="160" left="330" width="220" height="14" font="1">Right four</text>
    <image top="220" left="60" width="220" height="160" src="layout-1_1.png"/>
    <text top="390" left="60" width="220" height="14" font="1"><b>Figure 1.</b> Stable object.</text>
  </page>
</pdf2xml>`;

describe('standalone PDF deterministic preflight', () => {
  it('accepts complete bounded documents and meaningful metadata titles', () => {
    expect(parsePdfInfo('Title: Useful paper\nPages: 100\nEncrypted: no')).toEqual({
      pages: 100,
      title: 'Useful paper',
      encrypted: false,
    });
  });

  it('rejects encrypted, malformed, and over-limit PDFs instead of truncating them', () => {
    expect(() => parsePdfInfo('Pages: 0\nEncrypted: no')).toThrow('valid page count');
    expect(() => parsePdfInfo('Pages: 4\nEncrypted: yes (print:yes copy:no)')).toThrow('Encrypted');
    expect(() => parsePdfInfo(`Pages: ${pdfConversionPageLimit + 1}\nEncrypted: no`)).toThrow('will not truncate');
  });
});

describe('positioned PDF reading order', () => {
  it('parses native text and object coordinates without treating XML markup as prose', () => {
    const parsed = parsePdfLayoutXml(layoutXml);
    expect(parsed.pages).toHaveLength(1);
    expect(parsed.pages[0]).toMatchObject({ number: 1, width: 600, height: 800 });
    expect(parsed.pages[0]?.spans[0]).toMatchObject({
      id: 'p001-t00001',
      text: 'A Complete & Reproducible Paper',
      fontSize: 24,
    });
    expect(parsed.pages[0]?.images).toEqual([
      expect.objectContaining({ id: 'p001-i0001', top: 220, left: 60, width: 220, height: 160 }),
    ]);
    expect(parsed.pages[0]?.spans.at(-1)?.text).toBe('Figure 1. Stable object.');
  });

  it('orders a two-column page down the left column before the right column', () => {
    const page = parsePdfLayoutXml(layoutXml).pages[0]!, blocks = readingBlocks(page);
    expect(blocks.map(block => block.text)).toEqual([
      'A Complete & Reproducible Paper',
      'Left one Left two Left three Left four',
      'Figure 1. Stable object.',
      'Right one Right two Right three Right four',
    ]);
    expect(blocks.map(block => block.kind)).toEqual(['heading', 'paragraph', 'caption', 'paragraph']);
    expect(blocks[1]?.spanIds).toEqual(['p001-t00002', 'p001-t00003', 'p001-t00004', 'p001-t00005']);
  });

  it('keeps the computed column order in the published reading HTML', () => {
    const parsed = parsePdfLayoutXml(layoutXml), page = parsed.pages[0]!, blocks = readingBlocks(page);
    const html = renderReadingHtml(parsed, 'Complete paper', new Map([[1, 'assets/page.jpg']]), new Map([[1, blocks]]), []);
    const left = html.indexOf('Left one Left two Left three Left four');
    const caption = html.indexOf('Figure 1. Stable object.');
    const right = html.indexOf('Right one Right two Right three Right four');
    expect(left).toBeGreaterThan(-1);
    expect(left).toBeLessThan(caption);
    expect(caption).toBeLessThan(right);
  });

  it('reconstructs adjacent same-style title lines and closes a wrapped hyphen', () => {
    const multiline = layoutXml.replace(
      '<text top="30" left="60" width="480" height="28" font="0">A Complete &amp; Reproducible Paper</text>',
      `<text top="30" left="60" width="480" height="28" font="0">Enabling Reinforcement Learning to Two-</text>
       <text top="56" left="60" width="480" height="28" font="0">Dimensional Freeform Metasurface Inverse Design</text>
       <text top="82" left="160" width="280" height="28" font="0">via Fourier Level-set Representation</text>`,
    );
    const parsed = parsePdfLayoutXml(multiline);
    expect(readingBlocks(parsed.pages[0]!).slice(0, 3).map(block => block.text)).toEqual([
      'Enabling Reinforcement Learning to Two-',
      'Dimensional Freeform Metasurface Inverse Design',
      'via Fourier Level-set Representation',
    ]);
    expect(pdfTitleCandidate(parsed, undefined, 'fallback.pdf')).toBe(
      'Enabling Reinforcement Learning to Two-Dimensional Freeform Metasurface Inverse Design via Fourier Level-set Representation',
    );
  });
});

function fixturePdf(): Buffer {
  const parts = ['%PDF-1.4\n'], offsets: number[] = [0];
  const add = (id: number, value: string) => {
    offsets[id] = Buffer.byteLength(parts.join(''));
    parts.push(`${id} 0 obj\n${value}\nendobj\n`);
  };
  const streamOne = [
    'BT /F1 22 Tf 72 740 Td (Standalone PDF Paper) Tj ET',
    'BT /F1 11 Tf 72 700 Td (A native text paragraph for deterministic extraction.) Tj ET',
    'BT /F1 11 Tf 72 682 Td (A second line continues the paper body.) Tj ET',
    '0.8 0.2 0.2 rg 72 500 220 120 re f',
  ].join('\n');
  const streamTwo = '0.2 0.3 0.8 rg 40 80 532 632 re f\n';
  add(1, '<< /Type /Catalog /Pages 2 0 R >>');
  add(2, '<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>');
  add(3, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 7 0 R >> >> /Contents 4 0 R >>');
  add(4, `<< /Length ${Buffer.byteLength(streamOne)} >>\nstream\n${streamOne}\nendstream`);
  add(5, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << >> /Contents 6 0 R >>');
  add(6, `<< /Length ${Buffer.byteLength(streamTwo)} >>\nstream\n${streamTwo}\nendstream`);
  add(7, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const xref = Buffer.byteLength(parts.join(''));
  parts.push('xref\n0 8\n0000000000 65535 f \n');
  for (let id = 1; id <= 7; id++) parts.push(`${String(offsets[id]).padStart(10, '0')} 00000 n \n`);
  parts.push(`trailer\n<< /Size 8 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return Buffer.from(parts.join(''));
}

let hasPoppler = true;
for (const path of ['/usr/bin/pdfinfo', '/usr/bin/pdftohtml', '/usr/bin/pdftoppm', '/usr/bin/zip']) {
  try { await access(path) } catch { hasPoppler = false }
}

describe.runIf(hasPoppler)('standalone PDF conversion', () => {
  it('publishes every page as a folded 144-DPI fallback and reuses them for optional QA', async () => {
    const withoutReference = await convertPdf(fixturePdf(), { filename: '../fixture.pdf', includeReference: false });
    try {
      const archive = await scanZip(withoutReference.archivePath, {
        collect: name => name === 'manifest.json' || name === 'document.html' || name === 'provenance/pdf-layout.json',
      });
      const manifest = JSON.parse(archive.collected.get('manifest.json')!.toString('utf8')) as any;
      const html = archive.collected.get('document.html')!.toString('utf8');
      expect(manifest).toMatchObject({
        operation: 'convert',
        source: { kind: 'pdf', filename: 'fixture.pdf', pages: 2 },
        converter: { selected: 'poppler-hybrid-pdf' },
        output: { entryPath: 'document.html', inventory: { pages: 2, pageFallbacks: 2, referencePages: 0 } },
      });
      expect(archive.entries.filter(entry => /^assets\/pdf-page-\d{3}\.jpg$/.test(entry.name))).toHaveLength(2);
      expect(archive.entries.some(entry => entry.name.startsWith('reference/'))).toBe(false);
      expect(html).toContain('Standalone PDF Paper');
      expect(html.match(/<details class="pdf-source-page"/g)).toHaveLength(2);
      expect(html).toContain('Original PDF page 2');
      expect(html).not.toMatch(/pdf:p002:source-page" open/);
      expect(html).toContain('Open the original page image below');
      expect(JSON.parse(archive.collected.get('provenance/pdf-layout.json')!.toString('utf8')).pages).toHaveLength(2);
    } finally { await rm(withoutReference.root, { recursive: true, force: true }) }

    const withReference = await convertPdf(fixturePdf(), {
      filename: 'fixture.pdf',
      includeReference: true,
      referencePages: 1,
    });
    try {
      const archive = await scanZip(withReference.archivePath, { collect: name => name === 'manifest.json' });
      const manifest = JSON.parse(archive.collected.get('manifest.json')!.toString('utf8')) as any;
      expect(manifest.output.inventory.referencePages).toBe(1);
      expect(archive.entries.filter(entry => /^reference\/page-\d{3}\.jpg$/.test(entry.name))).toHaveLength(0);
      expect(archive.entries.filter(entry => /^assets\/pdf-page-\d{3}\.jpg$/.test(entry.name))).toHaveLength(2);
      expect(manifest.warnings).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'reference_pages_sampled' })]));
    } finally { await rm(withReference.root, { recursive: true, force: true }) }
  }, 120_000);
});
