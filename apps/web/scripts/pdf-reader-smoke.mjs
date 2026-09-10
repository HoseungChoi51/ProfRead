import assert from 'node:assert/strict';
import {Buffer} from 'node:buffer';
import console from 'node:console';
import {createHash} from 'node:crypto';
import {dirname, resolve} from 'node:path';
import {fileURLToPath, URL} from 'node:url';
import {chromium} from 'playwright-core';
import {createServer} from 'vite';
import {extractNativeReadingPage, withReadingPdf} from '../../academic-worker/src/pdf-reading.ts';

// Run with node --import tsx apps/web/scripts/pdf-reader-smoke.mjs.
// The real browser and PDF engine use an isolated in-memory API fixture.
function fixturePdf() {
  const objects = [], pageCount = 8, font = pageCount * 2 + 3;
  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objects[2] = `<< /Type /Pages /Kids [${Array.from({length: pageCount}, (_, index) => `${index * 2 + 3} 0 R`).join(' ')}] /Count ${pageCount} >>`;
  for (let index = 0; index < pageCount; index++) {
    const id = index * 2 + 3;
    objects[id] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /CropBox [20 30 592 762] ${index === 1 ? '/Rotate 90' : ''} /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${id + 1} 0 R >>`;
    const stream = index === 2 ? '0.1 0.2 0.8 rg 60 450 200 170 re f' : `BT /F1 18 Tf 60 700 Td (First native PDF passage on page ${index + 1}.) Tj 0 -35 Td (A second line for discussions and highlights.) Tj ET\n0.9 0.2 0.1 rg 60 450 160 100 re f`;
    objects[id + 1] = `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`;
  }
  objects[font] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';
  let source = '%PDF-1.7\n';
  const offsets = [0];
  for (let id = 1; id <= font; id++) {offsets[id] = Buffer.byteLength(source); source += `${id} 0 obj\n${objects[id]}\nendobj\n`;}
  const xref = Buffer.byteLength(source);
  source += `xref\n0 ${font + 1}\n0000000000 65535 f \n`;
  for (let id = 1; id <= font; id++) source += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`;
  source += `trailer\n<< /Size ${font + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(source);
}

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = fixturePdf(), sourceHash = createHash('sha256').update(source).digest('hex');
const pages = await withReadingPdf(source, undefined, async pdf => {
  const result = [];
  for (let number = 1; number <= pdf.numPages; number++) {
    const page = await extractNativeReadingPage(await pdf.getPage(number), number, number + 20);
    result.push({page: number, sourcePage: number + 20, view: page.view, rotation: page.rotation, text: page.text, textStatus: page.status, items: page.items.map(({str, ...item}) => ({...item, text: str}))});
  }
  return result;
});
const representationId = 'pdf-smoke', manifest = {representationId, sourceHash, pdfHash: sourceHash, url: `/api/representations/${representationId}/pdf`, extractionRevision: 1, status: 'ready', ocrLanguage: 'eng', pages};
const pdfRepresentation = {id: representationId, documentVersionId: 'original-pdf-version', version: 1, kind: 'pdf', status: 'ready', extractionRevision: 1, pageCount: pages.length}, htmlRepresentation = {id: 'html-smoke', documentVersionId: 'smoke-version', version: 2, kind: 'html', status: 'ready', extractionRevision: 0};
const document = {id: 'smoke-document', title: 'PDF reader smoke fixture', version_id: 'smoke-version', version: 2, block_id: null, offset_ratio: 0, last_thread_id: null, representations: [htmlRepresentation, pdfRepresentation], preferredRepresentationId: representationId, pdfSourceAvailable: true};
const anchors = new Map(), highlights = [], threads = [{id: 'html-thread', document_id: document.id, anchor_id: 'html-anchor', block_id: 'html-block', block_type: 'text', exact_quote: 'Legacy HTML passage', local_start_offset: 0, local_end_offset: 19, status: 'attached', representation: 'html', messages: []}];
const failures = [], browserErrors = [];
let progress, nextId = 0;
const indexRequests = [];
const server = await createServer({root: webRoot, configFile: resolve(webRoot, 'vite.config.ts'), server: {host: '127.0.0.1', port: 4327, strictPort: true}});
let browser, page;
try {
  await server.listen();
  browser = await chromium.launch({executablePath: '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox']});
  const context = await browser.newContext({viewport: {width: 1440, height: 1000}, deviceScaleFactor: 1});
  await context.route('**/api/**', async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname, method = request.method();
    const send = value => route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify(value)});
    if (path === '/api/auth/session') return send({authenticated: true});
    if (path === `/api/documents/${document.id}`) return send(document);
    if (path === `/api/representations/${representationId}/manifest`) return send({...manifest, ...(progress ? {progress} : {})});
    if (path === `/api/representations/${representationId}/pdf`) return route.fulfill({status: 200, contentType: 'application/pdf', body: source});
    if (path === `/api/representations/${representationId}/ocr`) {indexRequests.push(request.postDataJSON()); manifest.status = 'indexing'; pdfRepresentation.status = 'indexing'; return send({status: 'queued'});}
    if (path === `/api/representations/${representationId}/index/cancel`) {manifest.status = 'partial'; pdfRepresentation.status = 'partial'; return send({ok: true});}
    if (path === `/api/documents/${document.id}/threads`) return send(threads);
    if (path === `/api/documents/${document.id}/highlights`) return send(highlights);
    if (path === `/api/documents/${document.id}/artifacts`) return send([]);
    if (path.endsWith('/edit-history')) return send({currentRevision: 0, revisions: []});
    if (path === '/api/settings/models') return send({models: [], taskRoutes: []});
    if (path === '/api/routing/preview') return send({providerId: 'fixture', modelId: 'fixture', profile: 'standard', enabledTools: []});
    if (path.endsWith('/content')) return route.fulfill({contentType: 'text/html', body: '<!doctype html><html><body><p data-block-id="html-block">Legacy HTML passage</p><script>parent.postMessage({source:"profread",type:"ready"},"*")</script></body></html>'});
    if (path.endsWith('/progress')) {const value = request.postDataJSON(); if (value.representationId === representationId && value.page) progress = value; if (value.representationId) document.preferredRepresentationId = value.representationId; return send({ok: true});}
    if (path === '/api/anchors' && method === 'POST') {
      const {selector, documentVersionId} = request.postDataJSON();
      assert.equal(documentVersionId, 'original-pdf-version', 'An HTML reimport must not move selections off the original PDF version');
      assert.equal(selector.representationId, representationId);
      for (const segment of selector.segments) {
        if (selector.kind === 'pdf-text') assert.equal(pages[segment.page - 1].text.slice(segment.startOffset, segment.endOffset), segment.exact);
      }
      const id = `anchor-${++nextId}`; anchors.set(id, selector); return send({id});
    }
    if (path === '/api/highlights' && method === 'POST') {
      const value = request.postDataJSON(), selector = anchors.get(value.anchorId);
      highlights.push({id: `highlight-${++nextId}`, anchor_id: value.anchorId, selector, exact_quote: selector.exact, kind: value.kind, note: value.note, status: 'attached', checked: 1, representation: 'pdf'});
      return send({id: highlights.at(-1).id});
    }
    failures.push(`${method} ${path}`);
    return send([]);
  });
  page = await context.newPage();
  page.on('pageerror', error => browserErrors.push(error.message));
  await page.goto('http://127.0.0.1:4327/documents/smoke-document');
  await page.waitForSelector('[data-pdf-page="1"] [data-pdf-text-item]');
  assert.equal(await page.getByRole('button', {name: 'Writer', exact: true}).count(), 0);
  assert.equal(await page.getByRole('button', {name: /Document Writer/}).count(), 0);
  await page.locator('[data-pdf-page="1"] canvas[data-rendered="true"]').waitFor();
  const blackTextPixels = await page.locator('[data-pdf-page="1"] canvas').evaluate(canvas => {
    const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, 130).data;
    let dark = 0; for (let offset = 0; offset < data.length; offset += 4) if (data[offset] < 80 && data[offset + 1] < 80 && data[offset + 2] < 80 && data[offset + 3] > 200) dark++;
    return dark;
  });
  assert.ok(blackTextPixels > 300, `Actual PDF canvas must paint native text, got ${blackTextPixels} dark pixels`);
  assert.ok(await page.locator('.pdf-page-surface canvas').count() < pages.length, 'Only visible PDF pages should allocate canvases');
  const span = page.locator('[data-pdf-page="1"] [data-pdf-text-item]').first();
  await span.evaluate(element => {const range = element.ownerDocument.createRange(); range.setStart(element.firstChild, 6); range.setEnd(element.firstChild, 16); const view = element.ownerDocument.defaultView, selected = view.getSelection(); selected.removeAllRanges(); selected.addRange(range); element.dispatchEvent(new view.MouseEvent('mouseup', {bubbles: true}));});
  await page.getByRole('button', {name: 'Highlight', exact: true}).click();
  await page.getByRole('button', {name: 'Add highlight', exact: true}).click();
  await page.waitForSelector('.pdf-mark-important');
  assert.equal(highlights[0].exact_quote, 'native PDF');
  const stored = JSON.parse(JSON.stringify(highlights[0].selector));
  await page.getByRole('button', {name: /^Entries/}).click();
  await page.getByRole('button', {name: 'Zoom in', exact: true}).click();
  await page.getByRole('button', {name: 'Rotate PDF clockwise'}).click();
  await page.waitForTimeout(700);
  assert.deepEqual(highlights[0].selector, stored, 'Viewport changes must never rewrite saved source geometry');
  assert.ok(await page.locator('.pdf-mark-important').count());
  await page.getByRole('button', {name: 'Select region', exact: true}).click();
  const bounds = await page.locator('[data-pdf-page="1"] .pdf-page-surface').boundingBox();
  await page.mouse.move(bounds.x + 100, bounds.y + 130); await page.mouse.down(); await page.mouse.move(bounds.x + 200, bounds.y + 230, {steps: 4}); await page.mouse.up();
  await page.getByRole('button', {name: 'Highlight', exact: true}).click();
  await page.getByRole('combobox', {name: 'Highlight kind'}).selectOption('comment');
  await page.getByRole('textbox', {name: 'Highlight comment'}).fill('Discuss this visual region');
  await page.getByRole('button', {name: 'Add highlight', exact: true}).click();
  await page.locator('.pdf-mark-comment').first().waitFor();
  assert.equal(highlights[1].selector.kind, 'pdf-region');
  assert.equal(highlights[1].selector.exact, '');
  await page.getByRole('button', {name: /^Entries/}).click();
  await page.getByRole('button', {name: 'Select region', exact: true}).click();
  await page.getByRole('textbox', {name: 'Search PDF text'}).fill('page 8');
  await page.getByRole('textbox', {name: 'Search PDF text'}).press('Enter');
  await page.waitForTimeout(600);
  assert.equal(await page.getByLabel('PDF reader page').inputValue(), '8');
  await page.getByRole('button', {name: /^Entries/}).click();
  await page.getByRole('button', {name: /Legacy HTML passage/}).first().click();
  await page.waitForSelector('iframe');
  assert.equal(await page.getByLabel('Reading view').inputValue(), 'html-smoke');
  await page.waitForTimeout(600);
  assert.equal(await page.getByLabel('Reading view').inputValue(), 'html-smoke');
  await page.screenshot({path: '/tmp/profread-html-discussion-smoke.png'});
  await page.getByLabel('Reading view').selectOption(representationId);
  await page.waitForSelector('[data-pdf-text-item]');
  assert.equal(await page.getByRole('button', {name: /Document Writer/}).count(), 0);
  for (let turn = 0; turn < 3; turn++) await page.getByRole('button', {name: 'Rotate PDF clockwise'}).click();
  await page.getByRole('button', {name: 'Fit width', exact: true}).click();
  await page.getByLabel('PDF reader page').fill('1'); await page.getByLabel('PDF reader page').press('Enter');
  await page.locator('[data-pdf-page="1"] canvas[data-rendered="true"]').waitFor();
  await page.getByRole('button', {name: /native PDF.*PDF/}).first().click();
  await page.waitForTimeout(300);
  const layout = await page.locator('.pdf-toolbar').evaluate(element => ({right: element.getBoundingClientRect().right, controls: [...element.querySelectorAll('button,input')].map(control => control.getBoundingClientRect().right)}));
  assert.ok(layout.controls.every(right => right <= layout.right + 1), 'PDF toolbar controls must wrap inside the reader column');
  await page.screenshot({path: '/tmp/profread-pdf-reader-smoke.png'});
  await page.getByText('Text tools', {exact: true}).click();
  await page.getByRole('button', {name: 'Retry this page', exact: true}).click();
  await page.getByRole('button', {name: 'Cancel indexing', exact: true}).click();
  await page.getByLabel('PDF OCR language').selectOption('eng+kor');
  await page.getByRole('button', {name: 'OCR this page', exact: true}).click();
  await page.getByRole('button', {name: 'Cancel indexing', exact: true}).click();
  assert.deepEqual(indexRequests.map(({page, force, ocrLanguage}) => ({page, force, ocrLanguage})), [{page: 1, force: false, ocrLanguage: 'eng'}, {page: 1, force: true, ocrLanguage: 'eng+kor'}]);
  assert.equal(browserErrors.length, 0, browserErrors.join('\n'));
  assert.equal(failures.length, 0, failures.join('\n'));
  console.log(JSON.stringify({ok: true, highlights: highlights.length, pages: pages.length, screenshot: '/tmp/profread-pdf-reader-smoke.png'}));
} catch (error) {
  if (page) {
    await page.screenshot({path: '/tmp/profread-pdf-smoke-failure.png'}).catch(() => {});
    console.error(JSON.stringify({browserErrors, failures, page: await page.getByLabel('PDF reader page').inputValue().catch(() => ''), renderErrors: await page.locator('.pdf-page-render-error').allTextContents(), canvases: await page.locator('canvas').evaluateAll(elements => elements.map(element => ({page: element.closest('[data-pdf-page]')?.dataset.pdfPage, rendered: element.dataset.rendered, width: element.width, height: element.height})))}));
  }
  throw error;
} finally {await browser?.close(); await server.close();}
