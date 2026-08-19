import { createReadStream } from 'node:fs';
import { access, rm } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { basename, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { pathToFileURL } from 'node:url';
import { convertDocx, convertTex, type OperationResult } from './convert.js';
import { WorkerError, errorMessage } from './errors.js';
import { renderPdf } from './pdf.js';
import { convertPdf } from './pdf-convert.js';
import { chromiumPath, renderHtml } from './render.js';
import { convertJats } from './jats.js';

const defaultBodyLimit = 100 * 1024 * 1024;
const port = Number(process.env.ACADEMIC_WORKER_PORT ?? 4312), concurrency = Number(process.env.ACADEMIC_WORKER_CONCURRENCY ?? 1);
let active = 0;
export function workerBodyLimit(): number { const configured=Number(process.env.ACADEMIC_WORKER_MAX_BODY_BYTES??defaultBodyLimit);return Number.isFinite(configured)&&configured>0?Math.min(configured,defaultBodyLimit):defaultBodyLimit; }
function json(response: ServerResponse, statusCode: number, value: unknown): void { const body = Buffer.from(JSON.stringify(value)); response.writeHead(statusCode, { 'content-type': 'application/json; charset=utf-8', 'content-length': body.byteLength, 'cache-control': 'no-store' }); response.end(body); }
async function commandAvailable(command: string): Promise<boolean> { for (const directory of (process.env.PATH ?? '').split(':')) { try { await access(join(directory, command)); return true; } catch { /* try next */ } } return false; }
async function body(request: IncomingMessage): Promise<Buffer> { const chunks: Buffer[] = [],maximum=workerBodyLimit(); let bytes = 0; for await (const chunk of request) { const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array); bytes += value.byteLength; if (bytes > maximum) throw new WorkerError('body_too_large', `Request exceeds ${maximum} bytes.`, 413); chunks.push(value); } if (!bytes) throw new WorkerError('empty_body', 'A source body is required.'); return Buffer.concat(chunks); }
async function archive(response: ServerResponse, result: OperationResult): Promise<void> {
  try {
    response.writeHead(200, { 'content-type': 'application/zip', 'content-disposition': `attachment; filename="${basename(result.downloadName)}"`, 'cache-control': 'no-store' });
    await pipeline(createReadStream(result.archivePath), response);
  } finally { await rm(result.root, { recursive: true, force: true }); }
}
async function health(response: ServerResponse): Promise<void> { const tools = { pandoc: await commandAvailable('pandoc'), latexml: await commandAvailable('latexml'), latexmlpost: await commandAvailable('latexmlpost'), libreoffice: await commandAvailable('libreoffice'), pdfinfo:await commandAvailable('pdfinfo'),pdftotext:await commandAvailable('pdftotext'),pdftohtml:await commandAvailable('pdftohtml'),pdfimages:await commandAvailable('pdfimages'),pdffonts:await commandAvailable('pdffonts'),pdftoppm: await commandAvailable('pdftoppm'), zip: await commandAvailable('zip'), chromium: Boolean(await chromiumPath()) },ready=Object.values(tools).every(Boolean); json(response, ready ? 200 : 503, { status: ready ? 'ok' : 'degraded', active, concurrency, tools }); }

export function createAcademicWorker() {
  return createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://academic-worker');
    if (request.method === 'GET' && url.pathname === '/health') return health(response);
    if (request.method !== 'POST' || !['/v1/convert/docx', '/v1/convert/tex', '/v1/convert/jats', '/v1/convert/pdf', '/v1/render', '/v1/render/pdf'].includes(url.pathname)) return json(response, 404, { error: 'Not found' });
    if (active >= concurrency) { response.setHeader('retry-after', '5'); return json(response, 429, { error: 'Worker is busy', code: 'worker_busy' }); }
    active++; const controller = new AbortController();
    request.once('aborted', () => controller.abort());
    response.once('close', () => { if (!response.writableFinished) controller.abort(); });
    try {
      const input = await body(request); let result: OperationResult;
      if (url.pathname === '/v1/convert/docx') result = await convertDocx(input, { filename: url.searchParams.get('filename') ?? 'document.docx', includeReference: url.searchParams.get('reference') === 'true', referencePages: Number(url.searchParams.get('referencePages') ?? 60), signal: controller.signal });
      else if (url.pathname === '/v1/convert/tex') result = await convertTex(input, { filename: url.searchParams.get('filename') ?? 'source.tex', ...(url.searchParams.get('entry') ? { entry: url.searchParams.get('entry')! } : {}), signal: controller.signal });
      else if (url.pathname === '/v1/convert/jats') result = await convertJats(input, { filename: url.searchParams.get('filename') ?? 'article.xml', signal: controller.signal });
      else if (url.pathname === '/v1/convert/pdf') result = await convertPdf(input, { filename: url.searchParams.get('filename') ?? 'paper.pdf', includeReference: url.searchParams.get('reference') === 'true', referencePages: Number(url.searchParams.get('referencePages') ?? 60), signal: controller.signal });
      else if (url.pathname === '/v1/render/pdf') result = await renderPdf(input, { filename: url.searchParams.get('filename') ?? 'source.pdf', pages: Number(url.searchParams.get('pages') ?? 60), signal: controller.signal });
      else result = await renderHtml(input, { maxObjects: Number(url.searchParams.get('maxObjects') ?? 120), signal: controller.signal });
      await archive(response, result);
    } catch (error) { if (!response.headersSent) { const worker = error instanceof WorkerError ? error : undefined; json(response, worker?.statusCode ?? 500, { error: worker ? worker.message : 'Worker operation failed.', code: worker?.code ?? 'internal_error', ...(worker?.details??{}), ...(process.env.NODE_ENV === 'development' ? { detail: errorMessage(error) } : {}) }); } else response.destroy(); }
    finally { active--; }
  });
}
const main = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (main) { const server = createAcademicWorker(); server.requestTimeout = 20 * 60_000; server.headersTimeout = 30_000; server.listen(port, '0.0.0.0', () => process.stdout.write(`academic-worker listening on ${port}\n`)); }
