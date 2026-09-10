import assert from 'node:assert/strict';
import console from 'node:console';
import {randomBytes} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {dirname, resolve} from 'node:path';
import process from 'node:process';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright-core';

// Uses only the disposable fixture created by the PDF import smoke. It never
// configures a provider, starts a worker job, or touches the running service.
const directory = process.argv[2] ?? '/tmp/profread-pdf-smoke-xHV4WN';
assert.match(directory, /^\/tmp\/profread-pdf-smoke-[A-Za-z0-9_-]+$/);
const fixture = JSON.parse(await readFile(resolve(directory, 'smoke-result.json'), 'utf8'));
const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
process.env.PROFREAD_DATA_DIR = directory;
process.env.PROFREAD_PASSWORD = 'test-owner-password';
process.env.PROFREAD_SESSION_SECRET = randomBytes(32).toString('hex');
process.env.PROFREAD_BACKGROUND_JOBS = 'disabled';
process.env.PROFREAD_WEB_DIR = resolve(webRoot, 'dist');
process.env.NODE_ENV = 'test';
const {buildApp} = await import('../../server/src/app.ts');
const {db} = await import('../../server/src/db/index.ts');
const app = await buildApp();
app.log.level = 'warn';
let browser, page;
const errors = [], consoleWarnings = [], failedRequests = [];
try {
  const address = await app.listen({host: '127.0.0.1', port: 0});
  browser = await chromium.launch({executablePath: '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox']});
  const context = await browser.newContext({viewport: {width: 1600, height: 1100}, deviceScaleFactor: 1});
  const loggedIn = await context.request.post(address + '/api/auth/login', {data: {password: 'test-owner-password'}});
  assert.equal(loggedIn.status(), 200);
  const manifest = await (await context.request.get(address + `/api/representations/${fixture.representationId}/manifest`)).json();
  assert.deepEqual(manifest.pages.map(item => item.sourcePage), [22, 23, 24, 25, 26, 27, 28]);
  assert.match(manifest.pages[0].text, /mathematician/i);
  assert.match(manifest.pages[0].text, /AI/);
  const runsBefore = db.prepare('SELECT COUNT(*) count FROM model_runs').get().count;
  page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => {if (['warning', 'error'].includes(message.type())) consoleWarnings.push(message.text().replace(/data:[^'"\s]+/g, '[embedded data omitted]').slice(0, 700));});
  page.on('requestfailed', request => failedRequests.push({url: request.url(), error: request.failure()?.errorText}));
  await page.goto(address + `/documents/${fixture.documentId}`);
  await page.locator('[data-pdf-page="1"] canvas[data-rendered="true"]').waitFor({timeout: 60000});
  assert.equal(await page.getByRole('button', {name: /Document Writer/}).count(), 0);
  await page.getByRole('button', {name: 'Fit width', exact: true}).click();
  for (let attempt = 0; attempt < 12; attempt++) {
    const fits = await page.locator('[data-pdf-page="1"] .pdf-page-surface').evaluate(surface => surface.getBoundingClientRect().height < surface.closest('.pdf-viewport').clientHeight - 40);
    if (fits) break;
    await page.getByRole('button', {name: 'Zoom out', exact: true}).click();
    await page.waitForTimeout(100);
  }
  await page.locator('[data-pdf-page="1"] canvas[data-rendered="true"]').waitFor();
  await page.screenshot({path: '/tmp/profread-spectrum-reader.png'});
  await page.getByLabel('PDF reader page').fill('2'); await page.getByLabel('PDF reader page').press('Enter');
  await page.locator('[data-pdf-page="2"] canvas[data-rendered="true"]').waitFor();
  await page.locator('[data-pdf-page="2"] .pdf-page-surface').screenshot({path: '/tmp/profread-spectrum-page23.png'});
  const figurePixels = await page.locator('[data-pdf-page="2"] canvas').evaluate(canvas => {
    const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    let colored = 0; for (let index = 0; index < data.length; index += 4) if (Math.max(data[index], data[index + 1], data[index + 2]) - Math.min(data[index], data[index + 1], data[index + 2]) > 30) colored++;
    return colored;
  });
  assert.ok(figurePixels > 10000, `Spectrum page 23 illustration did not render: ${figurePixels} colored pixels`);
  await page.getByLabel('PDF reader page').fill('3'); await page.getByLabel('PDF reader page').press('Enter');
  await page.locator('[data-pdf-page="3"] canvas[data-rendered="true"]').waitFor();
  const paragraph = page.locator('[data-pdf-page="3"] [data-pdf-text-item]').filter({hasText: /[A-Za-z].{20}/}).first();
  const selectedText = await paragraph.textContent();
  assert.ok(selectedText?.trim());
  async function selectParagraph() {
    await paragraph.evaluate(element => {
      const range = element.ownerDocument.createRange(); range.selectNodeContents(element);
      const view = element.ownerDocument.defaultView, selection = view.getSelection(); selection.removeAllRanges(); selection.addRange(range);
      element.dispatchEvent(new view.MouseEvent('mouseup', {bubbles: true}));
    });
  }
  await selectParagraph();
  await page.getByRole('button', {name: 'Highlight', exact: true}).click();
  await page.getByRole('button', {name: 'Add highlight', exact: true}).click();
  await page.locator('[data-pdf-page="3"] .pdf-mark-important').first().waitFor();
  const saved = db.prepare('SELECT selector_json FROM anchors WHERE document_version_id=(SELECT document_version_id FROM document_representations WHERE id=?) AND exact_quote=? ORDER BY created_at DESC LIMIT 1').get(fixture.representationId, selectedText);
  assert.ok(saved, 'Real authenticated anchor endpoint must save the selected article text');
  assert.equal(JSON.parse(saved.selector_json).segments[0].page, 3);
  await page.getByRole('button', {name: /^Entries/}).click();

  // Verify the UI's context-coverage and local citation plumbing without any
  // provider call. The response exists only in this browser's intercepted API.
  const imagePage = manifest.pages[1], [x0, y0, x1, y1] = imagePage.view;
  const citation = {id: 'pdf-p23', label: 'PDF page 23 (smoke citation)', selector: {kind: 'pdf-region', representationId: manifest.representationId, sourceHash: manifest.sourceHash, extractionRevision: manifest.extractionRevision, exact: '', segments: [{page: 2, quads: [[x0, y1, x1, y1, x1, y0, x0, y0]]}]}};
  let mockThread;
  await context.route('**/api/runs', async route => {
    const request = route.request().postDataJSON(); mockThread = request.threadId;
    const events = [['route', {runId: 'browser-mock-only', providerId: 'mock', modelId: 'no-provider-called', contextTier: 'canonical', enabledTools: []}], ['source_context', {representationId: manifest.representationId, extractionRevision: manifest.extractionRevision, coverage: {totalPages: 7, includedPages: [3], partial: true}, imagesOmitted: [24]}], ['text_delta', {delta: 'Smoke-test response: simulated AI, not article analysis.'}], ['source_citations', {citations: [citation]}], ['done', {}]];
    await route.fulfill({contentType: 'text/event-stream', body: events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join('')});
  });
  await context.route(`**/api/documents/${fixture.documentId}/threads`, async route => {
    const response = await route.fetch(), threads = await response.json();
    for (const thread of threads) if (thread.id === mockThread) {const messages = typeof thread.messages === 'string' ? JSON.parse(thread.messages) : thread.messages; messages.push({id: 'browser-mock-answer', role: 'assistant', content: 'Smoke-test response: simulated AI, not article analysis.', createdAt: new Date().toISOString(), sourceCitations: [citation]}); thread.messages = messages;}
    await route.fulfill({response, json: threads});
  });
  await selectParagraph();
  await page.getByRole('button', {name: 'Ask', exact: true}).click();
  await page.getByRole('textbox', {name: 'Question', exact: true}).fill('Smoke test of PDF source context, no real model call.');
  await page.getByRole('textbox', {name: 'Question', exact: true}).press('Enter');
  const sourceButton = page.getByRole('button', {name: citation.label, exact: true});
  await sourceButton.waitFor();
  assert.match(await page.locator('.route-chip').textContent(), /1\/7 context pages.*partial text index.*1 page images omitted/);
  await sourceButton.click();
  await page.locator('[data-pdf-page="2"] canvas[data-rendered="true"]').waitFor();
  assert.equal(await page.getByLabel('PDF reader page').inputValue(), '2');
  await page.screenshot({path: '/tmp/profread-spectrum-citation-smoke.png'});
  assert.equal(db.prepare('SELECT COUNT(*) count FROM model_runs').get().count, runsBefore, 'No real provider run may be created');
  assert.equal(errors.length, 0, errors.join('\n'));
  assert.equal(consoleWarnings.filter(warning => /Content Security|violates|violated/i.test(warning)).length, 0, consoleWarnings.join('\n'));
  assert.equal(await page.locator('.pdf-page-render-error').count(), 0);
  console.log(JSON.stringify({ok: true, documentId: fixture.documentId, sourcePages: manifest.pages.map(item => item.sourcePage), savedQuote: selectedText, figurePixels, providerRunsCreated: 0, consoleWarnings, failedRequests, screenshots: ['/tmp/profread-spectrum-reader.png', '/tmp/profread-spectrum-page23.png', '/tmp/profread-spectrum-citation-smoke.png']}));
} catch (error) {
  await page?.screenshot({path: '/tmp/profread-spectrum-smoke-failure.png'}).catch(() => {});
  console.error(JSON.stringify({errors, consoleWarnings, failedRequests}));
  throw error;
} finally {await browser?.close(); await app.close(); db.close();}
