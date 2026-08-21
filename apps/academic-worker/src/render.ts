import { access, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { chromium, type Browser, type Page } from 'playwright-core';
import { assertFileWithinWorkerOutputLimit, bundleFiles, createZip, sha256Bytes, writeJson } from './files.js';
import { WorkerError } from './errors.js';
import type { OperationResult } from './convert.js';
import { workerEnvironment } from './process.js';

interface ViewSpec { name: 'desktop' | 'narrow'; width: number; height: number }
const views: ViewSpec[] = [{ name: 'desktop', width: 1440, height: 1000 }, { name: 'narrow', width: 768, height: 1400 }];
const renderCss = `*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}html{scroll-behavior:auto!important}body{overflow-wrap:anywhere}img,svg,video,canvas{max-width:100%;height:auto}table{max-width:100%}.afterdraft-qa-label{position:absolute!important;z-index:2147483647!important;padding:1px 4px!important;border:1px solid #7c2d12!important;border-radius:3px!important;background:#fff7ed!important;color:#7c2d12!important;font:600 10px/1.25 ui-monospace,monospace!important;box-shadow:0 1px 2px #0004!important;pointer-events:none!important}`;

export interface RenderMetric {
  ref: string; blockId?: string; tag: string; text?: string;
  textLength?: number; textTruncated?: boolean; textExcerptLimit?: number;
  rect: { x: number; y: number; width: number; height: number };
  clientWidth: number; scrollWidth: number; clientHeight: number; scrollHeight: number;
  overflowX: string; overflowY: string; visible: boolean; clippedX: boolean; clippedY: boolean;
  semanticObject?: { rootRef: string; rootBlockId?: string; rootTag: string; nested: boolean };
  structure?: Record<string, unknown>;
  svgGeometry?: {
    hasViewBox: boolean; viewBoxRaw?: string;
    viewport: { x: number; y: number; width: number; height: number };
    graphicsBounds?: { x: number; y: number; width: number; height: number };
    renderedAspectRatio?: number; expectedAspectRatio?: number;
    aspectRatioMismatch: boolean; contentOutsideViewport: boolean; markerCount: number;
  };
}

const screenshotTags = new Set(['figure', 'table', 'img', 'svg', 'math', 'video']);

function spreadMetrics(metrics: RenderMetric[], maximum: number): RenderMetric[] {
  if (maximum <= 0 || metrics.length === 0) return [];
  if (metrics.length <= maximum) return metrics;
  if (maximum === 1) return [metrics[0]!];
  const selected: RenderMetric[] = [];
  for (let index = 0; index < maximum; index++) {
    selected.push(metrics[Math.round(index * (metrics.length - 1) / (maximum - 1))]!);
  }
  return selected;
}

/** Prefer distinct visual objects across the whole document instead of the first DOM nodes. */
export function selectScreenshotMetrics(metrics: RenderMetric[], maximum: number): RenderMetric[] {
  const visible = metrics.filter(item => item.visible), visibleByRef = new Map(visible.map(item => [item.ref, item])), roots = new Map<string, RenderMetric>();
  for (const item of visible) {
    if (!screenshotTags.has(item.tag)) continue;
    const rootRef = item.semanticObject?.rootRef ?? item.ref;
    const root = visibleByRef.get(rootRef) ?? item;
    if (!roots.has(rootRef)) roots.set(rootRef, root);
  }
  const priority = [...roots.values()];
  const representatives: RenderMetric[] = [];
  for (const tag of [...new Set(priority.map(item => item.tag))]) {
    const representative = priority.find(item => item.tag === tag);
    if (representative) representatives.push(representative);
  }
  if (representatives.length >= maximum) return representatives.slice(0, maximum);
  const representativeRefs = new Set(representatives.map(item => item.ref));
  const selected = [...representatives, ...spreadMetrics(priority.filter(item => !representativeRefs.has(item.ref)), maximum - representatives.length)];
  if (selected.length >= maximum) return selected;
  const selectedRefs = new Set(selected.map(item => item.ref));
  const remaining = visible.filter(item => !selectedRefs.has(item.ref) && !roots.has(item.semanticObject?.rootRef ?? item.ref));
  selected.push(...spreadMetrics(remaining, maximum - selected.length));
  return selected;
}

function stripActiveContent(html: string): string {
  return html.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '').replace(/<base\b[^>]*>/gi, '').replace(/<meta\b[^>]*http-equiv\s*=\s*["']?refresh[\s\S]*?>/gi, '');
}
export async function chromiumPath(): Promise<string | undefined> {
  for (const candidate of [process.env.CHROMIUM_PATH, '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome'].filter(Boolean) as string[]) {
    try { await access(candidate); return candidate; } catch { /* try next */ }
  }
  return undefined;
}

async function metrics(page: Page): Promise<{ document: Record<string, number | boolean>; objects: RenderMetric[] }> {
  return page.evaluate(() => {
    const candidates = [...new Set([...document.querySelectorAll<HTMLElement>('[data-block-id],figure,table,img,svg,math,video')])];
    candidates.forEach((element, index) => { element.dataset.afterdraftQaId = `q${index.toString(36)}`; });
    const excerpt = (value: string | null | undefined, limit = 240) => {
      const full = value?.replace(/\s+/g, ' ').trim() ?? '';
      if (!full) return {};
      if (full.length <= limit) return { text: full, textLength: full.length, textTruncated: false, textExcerptLimit: limit };
      const candidate = full.slice(0, limit - 1), boundary = candidate.lastIndexOf(' ');
      return { text: `${boundary > 0 ? candidate.slice(0, boundary) : ''}…`, textLength: full.length, textTruncated: true, textExcerptLimit: limit };
    };
    const objects = candidates.map((element, index) => {
      const ref = `q${index.toString(36)}`;
      const rect = element.getBoundingClientRect(), style = getComputedStyle(element), visible = rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
      const tag = element.tagName.toLowerCase(), root = element.closest<HTMLElement>('figure,table') ?? element;
      const rootRef = root.dataset.afterdraftQaId ?? ref;
      let structure: Record<string, unknown> | undefined;
      if (tag === 'table') {
        const rows = [...element.querySelectorAll('tr')], cells = [...element.querySelectorAll('th,td')];
        structure = { kind: 'table', rowCount: rows.length, columnCount: Math.max(0, ...rows.map(row => [...row.querySelectorAll('th,td')].reduce((total, cell) => total + Number(cell.getAttribute('colspan') || 1), 0))), headerCellCount: cells.filter(cell => cell.tagName.toLowerCase() === 'th').length, dataCellCount: cells.filter(cell => cell.tagName.toLowerCase() === 'td').length, sampleRows: rows.slice(0, 8).map(row => [...row.querySelectorAll('th,td')].slice(0, 8).map(cell => excerpt(cell.textContent, 80).text ?? '')), sampleTruncated: rows.length > 8 || rows.some(row => row.querySelectorAll('th,td').length > 8) };
      } else if (tag === 'pre') {
        const raw = element.textContent ?? '', lines = raw.replace(/\r\n?/g, '\n').split('\n');
        structure = { kind: 'preformatted', lineCount: lines.length, longestLine: Math.max(0, ...lines.map(line => line.length)), characterCount: raw.length, whitespacePreserved: true };
      } else if (tag === 'figure') {
        const caption = element.querySelector(':scope > figcaption');
        structure = { kind: 'figure', visualChildCount: element.querySelectorAll('img,svg,video,math').length, ...(caption ? { caption: excerpt(caption.textContent, 240).text ?? '' } : {}) };
      }
      let svgGeometry: RenderMetric['svgGeometry'];
      if (tag === 'svg') {
        const svg = element as unknown as SVGSVGElement, viewBoxRaw = svg.getAttribute('viewBox')?.trim(), viewBox = svg.viewBox?.baseVal;
        const hasViewBox = Boolean(viewBoxRaw && viewBox && viewBox.width > 0 && viewBox.height > 0);
        const viewport = hasViewBox ? { x: viewBox!.x, y: viewBox!.y, width: viewBox!.width, height: viewBox!.height } : { x: 0, y: 0, width: element.clientWidth, height: element.clientHeight };
        let graphicsBounds: { x: number; y: number; width: number; height: number } | undefined;
        try { const bounds = svg.getBBox(); if ([bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite)) graphicsBounds = { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height }; } catch { /* unsupported SVG geometry */ }
        const renderedAspectRatio = rect.height > 0 ? rect.width / rect.height : undefined, expectedAspectRatio = viewport.height > 0 ? viewport.width / viewport.height : undefined, epsilon = 0.5;
        svgGeometry = { hasViewBox, ...(viewBoxRaw ? { viewBoxRaw } : {}), viewport, ...(graphicsBounds ? { graphicsBounds } : {}), ...(renderedAspectRatio ? { renderedAspectRatio } : {}), ...(expectedAspectRatio ? { expectedAspectRatio } : {}), aspectRatioMismatch: Boolean(renderedAspectRatio && expectedAspectRatio && Math.abs(renderedAspectRatio / expectedAspectRatio - 1) > 0.05), contentOutsideViewport: Boolean(graphicsBounds && (graphicsBounds.x < viewport.x - epsilon || graphicsBounds.y < viewport.y - epsilon || graphicsBounds.x + graphicsBounds.width > viewport.x + viewport.width + epsilon || graphicsBounds.y + graphicsBounds.height > viewport.y + viewport.height + epsilon)), markerCount: element.querySelectorAll('marker').length };
      }
      return { ref, ...(element.dataset.blockId ? { blockId: element.dataset.blockId } : {}), tag, ...excerpt(element.textContent), rect: { x: rect.x + scrollX, y: rect.y + scrollY, width: rect.width, height: rect.height }, clientWidth: element.clientWidth, scrollWidth: element.scrollWidth, clientHeight: element.clientHeight, scrollHeight: element.scrollHeight, overflowX: style.overflowX, overflowY: style.overflowY, visible, clippedX: element.scrollWidth > element.clientWidth + 1 && style.overflowX !== 'visible', clippedY: element.scrollHeight > element.clientHeight + 1 && style.overflowY !== 'visible', semanticObject: { rootRef, ...(root.dataset.blockId ? { rootBlockId: root.dataset.blockId } : {}), rootTag: root.tagName.toLowerCase(), nested: root !== element }, ...(structure ? { structure } : {}), ...(svgGeometry ? { svgGeometry } : {}) };
    });
    const root = document.documentElement;
    return { document: { viewportWidth: innerWidth, viewportHeight: innerHeight, scrollWidth: root.scrollWidth, scrollHeight: root.scrollHeight, horizontalOverflow: root.scrollWidth > innerWidth + 1 }, objects };
  });
}

async function captureOverview(page: Page, directory: string, view: ViewSpec, documentHeight: number): Promise<string[]> {
  const output: string[] = [], tileHeight = 12_000;
  if (documentHeight <= 30_000) { const path = join(directory, `${view.name}.png`); await page.screenshot({ path, fullPage: true, animations: 'disabled' }); return [`renders/${view.name}.png`]; }
  for (let y = 0, part = 1; y < documentHeight; y += tileHeight, part++) {
    const height = Math.min(tileHeight, documentHeight - y), name = `${view.name}-${String(part).padStart(3, '0')}.png`;
    await page.screenshot({ path: join(directory, name), clip: { x: 0, y, width: view.width, height }, animations: 'disabled' }); output.push(`renders/${name}`);
  }
  return output;
}

function contextClip(object: RenderMetric, view: ViewSpec, documentHeight: number): { x: number; y: number; width: number; height: number } {
  const boundedDocumentHeight = Math.max(1, Math.floor(documentHeight));
  const height = Math.max(1, Math.min(view.height, boundedDocumentHeight));
  const maximumY = Math.max(0, boundedDocumentHeight - height);
  const y = Math.max(0, Math.min(Math.floor(object.rect.y - (height - object.rect.height) / 2), maximumY));
  return { x: 0, y, width: view.width, height };
}

async function captureContext(page: Page, path: string, requestedY: number): Promise<{ x: number; y: number; width: number; height: number } | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const clip = await page.evaluate(y => { scrollTo(0, y); return { x: scrollX, y: scrollY, width: innerWidth, height: innerHeight }; }, requestedY);
      await page.screenshot({ path, animations: 'disabled' });
      return clip;
    } catch { /* retry one transient Chromium capture failure */ }
  }
  return null;
}

export async function renderHtml(body: Buffer, options: { maxObjects?: number; signal?: AbortSignal } = {}): Promise<OperationResult> {
  const executablePath = await chromiumPath(); if (!executablePath) throw new WorkerError('tool_unavailable', 'Chromium is unavailable.', 503);
  const root = await mkdtemp(join(tmpdir(), 'afterdraft-render-')), bundle = join(root, 'bundle'), renderDirectory = join(bundle, 'renders'); await mkdir(renderDirectory, { recursive: true });
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({ executablePath, headless: true, env: workerEnvironment(root), args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-background-networking', '--disable-component-update', '--disable-sync'], timeout: 30_000 });
    const html = stripActiveContent(body.toString('utf8')), viewResults: Array<Record<string, unknown>> = [], warnings: Array<Record<string, unknown>> = [];
    for (const view of views) {
      if (options.signal?.aborted) throw new WorkerError('request_aborted', 'The request was aborted.', 499);
      const context = await browser.newContext({ viewport: { width: view.width, height: view.height }, javaScriptEnabled: false, serviceWorkers: 'block', deviceScaleFactor: 1, colorScheme: 'light' });
      const failedResources: Array<{ url: string; reason?: string }> = [], consoleErrors: string[] = [];
      await context.route('**/*', route => { const protocol = new URL(route.request().url()).protocol; if (['data:', 'blob:', 'about:'].includes(protocol)) void route.continue(); else { failedResources.push({ url: route.request().url().slice(0, 500), reason: 'external requests blocked' }); void route.abort('blockedbyclient'); } });
      const page = await context.newPage(); page.on('requestfailed', request => { if (!failedResources.some(item => item.url === request.url())) failedResources.push({ url: request.url().slice(0, 500), ...(request.failure()?.errorText ? { reason: request.failure()!.errorText } : {}) }); }); page.on('console', message => { if (['error', 'warning'].includes(message.type()) && consoleErrors.length < 100) consoleErrors.push(message.text().slice(0, 1_000)); }); page.on('pageerror', error => { if (consoleErrors.length < 100) consoleErrors.push(error.message.slice(0, 1_000)); });
      await page.setContent(`<style>${renderCss}</style>${html}`, { waitUntil: 'load', timeout: 30_000 });
      await page.evaluate(async () => { await Promise.all([...document.images].map(image => image.complete ? Promise.resolve() : new Promise<void>(resolve => { image.addEventListener('load', () => resolve(), { once: true }); image.addEventListener('error', () => resolve(), { once: true }); }))); });
      const measured = await metrics(page), maximum = Math.max(0, Math.min(200, options.maxObjects ?? 120)), selectedObjects = selectScreenshotMetrics(measured.objects, maximum), contextObjects = selectScreenshotMetrics(measured.objects.filter(item => item.tag !== 'math'), Math.min(40, maximum)), contextRefs = new Set(contextObjects.map(item => item.ref)), selectedRefs = selectedObjects.map(item => item.ref);
      await page.evaluate(refs => { for (const ref of refs) { const element = document.querySelector<HTMLElement>(`[data-afterdraft-qa-id="${CSS.escape(ref)}"]`); if (!element) continue; const rect = element.getBoundingClientRect(), label = document.createElement('span'); label.className = 'afterdraft-qa-label'; label.textContent = element.dataset.afterdraftQaId ?? ''; label.style.left = `${Math.max(0, rect.left + scrollX)}px`; label.style.top = `${Math.max(0, rect.top + scrollY - 13)}px`; document.body.append(label); } }, selectedRefs);
      const screenshots = await captureOverview(page, renderDirectory, view, Number(measured.document.scrollHeight));
      const objectDirectory = join(bundle, 'objects', view.name), contextDirectory = join(bundle, 'contexts', view.name); await Promise.all([mkdir(objectDirectory, { recursive: true }), mkdir(contextDirectory, { recursive: true })]); const objectScreenshots: Array<{ ref: string; path: string }> = [], contextScreenshots: Array<{ ref: string; path: string; clip: { x: number; y: number; width: number; height: number } }> = [];
      for (const object of selectedObjects) {
        if (object.rect.height > 16_000 || object.rect.width > 16_000) { warnings.push({ code: 'object_screenshot_skipped', view: view.name, ref: object.ref, reason: 'oversized' }); continue; }
        const name = `${object.ref}.png`; try { await page.locator(`[data-afterdraft-qa-id="${object.ref}"]`).screenshot({ path: join(objectDirectory, name), animations: 'disabled' }); objectScreenshots.push({ ref: object.ref, path: `objects/${view.name}/${name}` }); } catch { warnings.push({ code: 'object_screenshot_failed', view: view.name, ref: object.ref }); }
        if (contextRefs.has(object.ref)) {
          const requested = contextClip(object, view, Number(measured.document.scrollHeight)), path = join(contextDirectory, name), clip = await captureContext(page, path, requested.y);
          if (clip) contextScreenshots.push({ ref: object.ref, path: `contexts/${view.name}/${name}`, clip });
          else warnings.push({ code: 'context_screenshot_failed', view: view.name, ref: object.ref });
        }
      }
      const semanticEligible = new Set(measured.objects.filter(item => item.visible && screenshotTags.has(item.tag)).map(item => item.semanticObject?.rootRef ?? item.ref)).size;
      const capturedRefs = new Set(objectScreenshots.map(item => item.ref));
      const semanticCaptured = new Set(selectedObjects.filter(item => capturedRefs.has(item.ref) && screenshotTags.has(item.tag)).map(item => item.semanticObject?.rootRef ?? item.ref)).size;
      viewResults.push({ viewport: view, document: measured.document, objects: measured.objects, screenshots, contextScreenshots, objectScreenshots, failedResources, consoleErrors, screenshotCoverage: { eligible: measured.objects.filter(item => item.visible).length, captured: objectScreenshots.length, contextEligible: contextObjects.length, contextCaptured: contextScreenshots.length, contextLimit: Math.min(40, maximum), limit: maximum, semanticEligible, semanticCaptured, semanticPrioritized: true } }); await context.close();
    }
    await browser.close(); browser = undefined;
    const manifest: Record<string, unknown> = { schemaVersion: 1, operation: 'render', inputContract: 'HTML must be self-contained; use data URLs for images and fonts. Relative, file, and network resources are blocked.', source: { kind: 'html', bytes: body.byteLength, sha256: sha256Bytes(body) }, renderer: { name: 'playwright-chromium', externalRequests: 'blocked', pageScripts: 'disabled', qaLabels: 'reading-view screenshots label measured objects with their q-ref' }, views: viewResults, warnings };
    manifest.files = await bundleFiles(bundle); await writeJson(join(bundle, 'manifest.json'), manifest); const archive = join(root, 'result.zip'); await createZip(bundle, archive, options.signal);
    await assertFileWithinWorkerOutputLimit(archive, 'Rendered HTML bundle exceeds the worker response limit.');
    return { root, archivePath: archive, downloadName: 'afterdraft-render-bundle.zip' };
  } catch (error) { await browser?.close().catch(() => {}); await rm(root, { recursive: true, force: true }); throw error; }
}
