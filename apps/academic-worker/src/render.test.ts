import { rm } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { chromiumPath, renderHtml, selectScreenshotMetrics, type RenderMetric } from './render.js';
import { scanZip } from './zip.js';

function metric(ref: string, tag: string, rootRef = ref): RenderMetric {
  return { ref, tag, rect: { x: 0, y: 0, width: 100, height: 100 }, clientWidth: 100, scrollWidth: 100, clientHeight: 100, scrollHeight: 100, overflowX: 'visible', overflowY: 'visible', visible: true, clippedX: false, clippedY: false, semanticObject: { rootRef, rootTag: rootRef === ref ? tag : 'figure', nested: rootRef !== ref } };
}

describe('render screenshot selection', () => {
  it('covers each visual class, collapses nested visuals, and includes late objects before prose', () => {
    const input = [metric('p0', 'p'), metric('f1', 'figure'), metric('s1', 'svg', 'f1'), ...Array.from({ length: 20 }, (_, index) => metric(`p${index + 1}`, 'p')), metric('t1', 'table'), metric('f2', 'figure'), metric('s2', 'svg', 'f2')];
    expect(selectScreenshotMetrics(input, 2).map(item => item.ref)).toEqual(['f1', 't1']);
    expect(selectScreenshotMetrics(input, 3).map(item => item.ref)).toEqual(['f1', 't1', 'f2']);
    expect(selectScreenshotMetrics(input, 0)).toEqual([]);
  });
});

const hasChromium = Boolean(await chromiumPath());
describe.runIf(hasChromium)('Playwright render evidence', () => {
  it('renders a self-contained figure at desktop and narrow widths', async () => {
    const html = Buffer.from(`<!doctype html><html><body><figure data-block-id="figure-1"><img alt="red fixture" width="160" height="80" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='80'%3E%3Crect width='160' height='80' fill='red'/%3E%3C/svg%3E"><figcaption>Figure 1. Red fixture.</figcaption></figure></body></html>`);
    const result = await renderHtml(html, { maxObjects: 10 });
    try {
      const zip = await scanZip(result.archivePath, { collect: name => name === 'manifest.json' || /(?:objects|contexts)\/.*\.png$/.test(name) });
      const manifest = JSON.parse(zip.collected.get('manifest.json')!.toString('utf8')) as any;
      expect(manifest.views.map((view: any) => [view.viewport.width, view.viewport.height])).toEqual([[1440, 1000], [768, 1400]]);
      const figure = manifest.views[0].objects.find((object: any) => object.blockId === 'figure-1');
      expect(figure.rect.width).toBeGreaterThan(100); expect(figure.rect.height).toBeGreaterThan(70);
      expect([...zip.collected.entries()].some(([name, value]) => name.startsWith('objects/desktop/') && value.byteLength > 500)).toBe(true);
      expect([...zip.collected.entries()].some(([name, value]) => name.startsWith('contexts/desktop/') && value.byteLength > 500)).toBe(true);
      expect(manifest.views[0].contextScreenshots[0]).toMatchObject({ ref: figure.ref, clip: { x: 0, width: 1440 } });
    } finally { await rm(result.root, { recursive: true, force: true }); }
  }, 30_000);

  it('records bounded excerpts, structure, SVG geometry, and semantic screenshot coverage', async () => {
    const longCaption = Array.from({ length: 70 }, (_, index) => `captionword${index}`).join(' ');
    const prose = Array.from({ length: 30 }, (_, index) => `<p data-block-id="p-${index}">Paragraph ${index}</p>`).join('');
    const html = Buffer.from(`<!doctype html><html><body>
      <figure data-block-id="figure-first"><svg viewBox="0 0 400 200" role="img"><defs><marker id="arrow" viewBox="0 0 10 10" markerWidth="8" markerHeight="8" refX="9" refY="5" orient="auto"><path d="M0 0L10 5L0 10Z"/></marker></defs><line x1="10" y1="100" x2="390" y2="100" stroke="black" marker-end="url(#arrow)"/></svg><figcaption>${longCaption}</figcaption></figure>
      ${prose}
      <table data-block-id="table-late"><thead><tr><th>Prompt class</th><th>Count</th></tr></thead><tbody><tr><td>Safe</td><td>11</td></tr><tr><td>Flagged</td><td>2</td></tr></tbody></table>
      <pre data-block-id="pre-late">first line\n  indented line\nthird line</pre>
      <figure data-block-id="figure-last"><svg width="150" height="100"><rect x="0" y="0" width="300" height="200" fill="blue"/></svg><figcaption>Late deliberately oversized diagram.</figcaption></figure>
    </body></html>`);
    const result = await renderHtml(html, { maxObjects: 3 });
    try {
      const zip = await scanZip(result.archivePath, { collect: name => name === 'manifest.json' || /contexts\/.*\.png$/.test(name) });
      const manifest = JSON.parse(zip.collected.get('manifest.json')!.toString('utf8')) as any;
      const view = manifest.views[0], firstFigure = view.objects.find((object: any) => object.blockId === 'figure-first');
      const safeSvg = view.objects.find((object: any) => object.tag === 'svg' && object.semanticObject?.rootBlockId === 'figure-first');
      const unsafeSvg = view.objects.find((object: any) => object.tag === 'svg' && object.semanticObject?.rootBlockId === 'figure-last');
      const table = view.objects.find((object: any) => object.blockId === 'table-late'), pre = view.objects.find((object: any) => object.blockId === 'pre-late');
      expect(firstFigure.textTruncated).toBe(true); expect(firstFigure.text).toMatch(/…$/); expect(firstFigure.textLength).toBeGreaterThan(firstFigure.textExcerptLimit);
      expect(safeSvg.semanticObject).toMatchObject({ rootRef: firstFigure.ref, rootBlockId: 'figure-first', rootTag: 'figure', nested: true });
      expect(safeSvg.svgGeometry).toMatchObject({ hasViewBox: true, viewBoxRaw: '0 0 400 200', contentOutsideViewport: false, markerCount: 1 });
      expect(unsafeSvg.svgGeometry).toMatchObject({ hasViewBox: false, contentOutsideViewport: true });
      expect(table.structure).toMatchObject({ kind: 'table', rowCount: 3, columnCount: 2, headerCellCount: 2, dataCellCount: 4, sampleTruncated: false });
      expect(table.structure.sampleRows[0]).toEqual(['Prompt class', 'Count']);
      expect(pre.structure).toMatchObject({ kind: 'preformatted', lineCount: 3, longestLine: 15, whitespacePreserved: true });
      const captured = new Set(view.objectScreenshots.map((item: any) => item.ref));
      expect(captured.has(firstFigure.ref)).toBe(true); expect(captured.has(table.ref)).toBe(true);
      const context = view.contextScreenshots.find((item: any) => item.ref === table.ref);
      expect(context.clip.height).toBeLessThan(view.document.scrollHeight);
      expect(zip.collected.get(context.path)?.byteLength).toBeGreaterThan(500);
      expect(view.screenshotCoverage).toMatchObject({ limit: 3, semanticEligible: 3, semanticCaptured: 3, semanticPrioritized: true });
    } finally { await rm(result.root, { recursive: true, force: true }); }
  }, 30_000);
});
