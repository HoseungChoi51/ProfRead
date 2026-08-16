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
  rect: { x: number; y: number; width: number; height: number };
  clientWidth: number; scrollWidth: number; clientHeight: number; scrollHeight: number;
  overflowX: string; overflowY: string; visible: boolean; clippedX: boolean; clippedY: boolean;
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
    const objects = candidates.map((element, index) => {
      const ref = `q${index.toString(36)}`; element.dataset.afterdraftQaId = ref;
      const rect = element.getBoundingClientRect(), style = getComputedStyle(element), visible = rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
      return { ref, ...(element.dataset.blockId ? { blockId: element.dataset.blockId } : {}), tag: element.tagName.toLowerCase(), ...(element.textContent?.trim() ? { text: element.textContent.trim().slice(0, 240) } : {}), rect: { x: rect.x + scrollX, y: rect.y + scrollY, width: rect.width, height: rect.height }, clientWidth: element.clientWidth, scrollWidth: element.scrollWidth, clientHeight: element.clientHeight, scrollHeight: element.scrollHeight, overflowX: style.overflowX, overflowY: style.overflowY, visible, clippedX: element.scrollWidth > element.clientWidth + 1 && style.overflowX !== 'visible', clippedY: element.scrollHeight > element.clientHeight + 1 && style.overflowY !== 'visible' };
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
      const measured = await metrics(page), maximum = Math.max(0, Math.min(200, options.maxObjects ?? 120));
      await page.evaluate(limit => { for (const element of [...document.querySelectorAll<HTMLElement>('[data-afterdraft-qa-id]')].slice(0, limit)) { const rect = element.getBoundingClientRect(), label = document.createElement('span'); label.className = 'afterdraft-qa-label'; label.textContent = element.dataset.afterdraftQaId ?? ''; label.style.left = `${Math.max(0, rect.left + scrollX)}px`; label.style.top = `${Math.max(0, rect.top + scrollY - 13)}px`; document.body.append(label); } }, maximum);
      const screenshots = await captureOverview(page, renderDirectory, view, Number(measured.document.scrollHeight));
      const objectDirectory = join(bundle, 'objects', view.name); await mkdir(objectDirectory, { recursive: true }); const objectScreenshots: Array<{ ref: string; path: string }> = [];
      for (const object of measured.objects.filter(item => item.visible).slice(0, maximum)) {
        if (object.rect.height > 16_000 || object.rect.width > 16_000) { warnings.push({ code: 'object_screenshot_skipped', view: view.name, ref: object.ref, reason: 'oversized' }); continue; }
        const name = `${object.ref}.png`; try { await page.locator(`[data-afterdraft-qa-id="${object.ref}"]`).screenshot({ path: join(objectDirectory, name), animations: 'disabled' }); objectScreenshots.push({ ref: object.ref, path: `objects/${view.name}/${name}` }); } catch { warnings.push({ code: 'object_screenshot_failed', view: view.name, ref: object.ref }); }
      }
      viewResults.push({ viewport: view, document: measured.document, objects: measured.objects, screenshots, objectScreenshots, failedResources, consoleErrors, screenshotCoverage: { eligible: measured.objects.filter(item => item.visible).length, captured: objectScreenshots.length, limit: maximum } }); await context.close();
    }
    await browser.close(); browser = undefined;
    const manifest: Record<string, unknown> = { schemaVersion: 1, operation: 'render', inputContract: 'HTML must be self-contained; use data URLs for images and fonts. Relative, file, and network resources are blocked.', source: { kind: 'html', bytes: body.byteLength, sha256: sha256Bytes(body) }, renderer: { name: 'playwright-chromium', externalRequests: 'blocked', pageScripts: 'disabled', qaLabels: 'overview screenshots label measured objects with their q-ref' }, views: viewResults, warnings };
    manifest.files = await bundleFiles(bundle); await writeJson(join(bundle, 'manifest.json'), manifest); const archive = join(root, 'result.zip'); await createZip(bundle, archive, options.signal);
    await assertFileWithinWorkerOutputLimit(archive, 'Rendered HTML bundle exceeds the worker response limit.');
    return { root, archivePath: archive, downloadName: 'afterdraft-render-bundle.zip' };
  } catch (error) { await browser?.close().catch(() => {}); await rm(root, { recursive: true, force: true }); throw error; }
}
