import { rm } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { chromiumPath, renderHtml } from './render.js';
import { scanZip } from './zip.js';

const hasChromium = Boolean(await chromiumPath());
describe.runIf(hasChromium)('Playwright render evidence', () => {
  it('renders a self-contained figure at desktop and narrow widths', async () => {
    const html = Buffer.from(`<!doctype html><html><body><figure data-block-id="figure-1"><img alt="red fixture" width="160" height="80" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='80'%3E%3Crect width='160' height='80' fill='red'/%3E%3C/svg%3E"><figcaption>Figure 1. Red fixture.</figcaption></figure></body></html>`);
    const result = await renderHtml(html, { maxObjects: 10 });
    try {
      const zip = await scanZip(result.archivePath, { collect: name => name === 'manifest.json' || /objects\/.*\.png$/.test(name) });
      const manifest = JSON.parse(zip.collected.get('manifest.json')!.toString('utf8')) as any;
      expect(manifest.views.map((view: any) => [view.viewport.width, view.viewport.height])).toEqual([[1440, 1000], [768, 1400]]);
      const figure = manifest.views[0].objects.find((object: any) => object.blockId === 'figure-1');
      expect(figure.rect.width).toBeGreaterThan(100); expect(figure.rect.height).toBeGreaterThan(70);
      expect([...zip.collected.entries()].some(([name, value]) => name.startsWith('objects/desktop/') && value.byteLength > 500)).toBe(true);
    } finally { await rm(result.root, { recursive: true, force: true }); }
  }, 30_000);
});
