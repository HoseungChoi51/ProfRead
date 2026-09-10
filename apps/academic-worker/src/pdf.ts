import { open, mkdir, mkdtemp, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';

import type { OperationResult } from './convert.js';
import { WorkerError } from './errors.js';
import { assertFileWithinWorkerOutputLimit, bundleFiles, createZip, sha256Bytes, workerOutputLimit, writeJson } from './files.js';
import { runCommand, type CommandResult } from './process.js';

type Attempt = { tool: string; exitCode: number; durationMs: number; stderr?: string };

const attempt = (result: CommandResult): Attempt => ({
  tool: result.command,
  exitCode: result.exitCode,
  durationMs: result.durationMs,
  ...(result.stderr.trim() ? { stderr: result.stderr.trim().slice(-2_000) } : {}),
});

export function pdfPageLimit(value: number | undefined): number {
  return Number.isFinite(value) ? Math.max(1, Math.min(60, Math.trunc(value!))) : 60;
}

export function hasPdfHeader(value: Uint8Array): boolean {
  return value.byteLength >= 8 && Buffer.from(value.subarray(0, 5)).toString('ascii') === '%PDF-';
}

async function pngDimensions(path: string): Promise<{ width: number; height: number }> {
  const handle = await open(path, 'r');
  try {
    const header = Buffer.alloc(24), { bytesRead } = await handle.read(header, 0, header.byteLength, 0);
    if (bytesRead !== header.byteLength || header.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') throw new WorkerError('invalid_render_output', 'Poppler produced an invalid PNG.', 500);
    return { width: header.readUInt32BE(16), height: header.readUInt32BE(20) };
  } finally { await handle.close(); }
}

export async function renderPdf(body: Buffer, options: { filename?: string; pages?: number; signal?: AbortSignal } = {}): Promise<OperationResult> {
  if (!hasPdfHeader(body)) throw new WorkerError('invalid_pdf', 'The source does not start with a PDF header.', 422);
  const root = await mkdtemp(join(tmpdir(), 'profread-pdf-')), input = join(root, 'source.pdf'), bundle = join(root, 'bundle'), reference = join(bundle, 'reference');
  await mkdir(reference, { recursive: true }); await writeFile(input, body, { mode: 0o600 });
  try {
    const limit = pdfPageLimit(options.pages), attempts: Attempt[] = [];
    const info = await runCommand('pdfinfo', [input], { cwd: root, signal: options.signal, timeoutMs: 30_000, allowFailure: true }); attempts.push(attempt(info));
    const sourcePages = Number(info.stdout.match(/^Pages:\s+(\d+)/mi)?.[1] ?? 0) || undefined;
    const raster = await runCommand('pdftoppm', ['-png', '-r', '96', '-scale-to', '2000', '-f', '1', '-l', String(limit), input, join(reference, 'raw')], { cwd: root, signal: options.signal, timeoutMs: 300_000 }); attempts.push(attempt(raster));
    const generated = (await readdir(reference)).map(name => ({ name, page: Number(name.match(/^raw-(\d+)\.png$/)?.[1] ?? 0) })).filter(item => item.page > 0).sort((left, right) => left.page - right.page);
    if (!generated.length) throw new WorkerError('invalid_render_output', 'Poppler did not produce any reference pages.', 422);
    const pages: Array<{ page: number; path: string; width: number; height: number; bytes: number }> = []; let totalBytes = 0;
    for (const generatedPage of generated) {
      const name = `page-${String(generatedPage.page).padStart(3, '0')}.png`, source = join(reference, generatedPage.name), target = join(reference, name); await rename(source, target);
      const dimensions = await pngDimensions(target), bytes = (await stat(target)).size; totalBytes += bytes;
      if (bytes > 64 * 1024 * 1024 || totalBytes > workerOutputLimit()) throw new WorkerError('output_too_large', 'Rendered PDF reference pages exceed the worker output limit.', 422);
      pages.push({ page: generatedPage.page, path: `reference/${name}`, ...dimensions, bytes });
    }
    const warnings = sourcePages && sourcePages > pages.length ? [{ code: 'reference_pages_truncated', severity: 'info' as const, message: `Rendered the first ${pages.length} of ${sourcePages} PDF pages.`, evidence: { sourcePages, renderedPages: pages.length } }] : [];
    const filename = basename(options.filename || 'source.pdf').replace(/[^\p{L}\p{N}._ -]/gu, '_').slice(0, 180) || 'source.pdf';
    const manifest: Record<string, unknown> = { schemaVersion: 1, operation: 'render', source: { kind: 'pdf', filename, bytes: body.byteLength, sha256: sha256Bytes(body), ...(sourcePages ? { pages: sourcePages } : {}) }, renderer: { name: 'pdftoppm', nominalDpi: 96, maxDimension: 2000, pageLimit: limit, attempts }, output: { kind: 'reference-pages', pages }, warnings };
    manifest.files = await bundleFiles(bundle); await writeJson(join(bundle, 'manifest.json'), manifest);
    const archivePath = join(root, 'result.zip'); await createZip(bundle, archivePath, options.signal);
    await assertFileWithinWorkerOutputLimit(archivePath, 'Rendered PDF bundle exceeds the worker response limit.');
    return { root, archivePath, downloadName: 'profread-pdf-reference.zip' };
  } catch (error) { await rm(root, { recursive: true, force: true }); throw error; }
}
