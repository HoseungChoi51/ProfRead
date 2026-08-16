import { basename, dirname, extname, join, posix, relative, resolve, sep } from 'node:path';
import { mkdtemp, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { assertFileWithinWorkerOutputLimit, bundleFiles, createZip, sha256Bytes, writeJson } from './files.js';
import { WorkerError, errorMessage } from './errors.js';
import { extractDocxFieldProvenance, inventoryDocx, type AcademicWarning } from './ooxml.js';
import { runCommand, type CommandResult } from './process.js';
import { scanZip } from './zip.js';

export interface OperationResult { root: string; archivePath: string; downloadName: string }
export interface ConversionOptions { filename: string; includeReference?: boolean; referencePages?: number; entry?: string; signal?: AbortSignal }
type Attempt = { tool: string; exitCode: number; durationMs: number; stderr?: string };
const safeFilename = (value: string, fallback: string) => basename(value || fallback).replace(/[^\p{L}\p{N}._ -]/gu, '_').slice(0, 180) || fallback;
const cleanAttempt = (result: CommandResult): Attempt => ({ tool: result.command, exitCode: result.exitCode, durationMs: result.durationMs, ...(result.stderr.trim() ? { stderr: result.stderr.trim().slice(-2_000) } : {}) });

export function inventoryConvertedHtml(source: string) {
  return {
    mathObjects: source.match(/<math\b/gi)?.length ?? 0,
    images: source.match(/<img\b/gi)?.length ?? 0,
    tables: source.match(/<table\b/gi)?.length ?? 0,
    rawZoteroFieldCodes: /\bZOTERO_(?:ITEM|BIBL)\b/i.test(source),
  };
}

async function optionalCommand(command: string, args: string[], cwd: string, signal?: AbortSignal, timeoutMs = 120_000): Promise<Attempt> {
  try { return cleanAttempt(await runCommand(command, args, { cwd, signal, timeoutMs, allowFailure: true })); }
  catch (error) { if (error instanceof WorkerError && error.code === 'request_aborted') throw error; return { tool: command, exitCode: 127, durationMs: 0, stderr: errorMessage(error).slice(-2_000) }; }
}
async function finalize(root: string, bundle: string, manifest: Record<string, unknown>, signal?: AbortSignal): Promise<string> {
  const files = await bundleFiles(bundle);
  manifest.files = files;
  manifest.provenanceFiles = files.filter(file => file.path.startsWith('provenance/'));
  await writeJson(join(bundle, 'manifest.json'), manifest);
  const archive = join(root, 'result.zip'); await createZip(bundle, archive, signal);
  await assertFileWithinWorkerOutputLimit(archive, 'Converted document bundle exceeds the worker response limit.');
  return archive;
}

async function referenceThumbnails(docx: string, root: string, bundle: string, pages: number, warnings: AcademicWarning[], attempts: Attempt[], signal?: AbortSignal): Promise<void> {
  const office = join(root, 'office'), profile = join(root, 'libreoffice-profile'); await mkdir(office, { recursive: true }); await mkdir(profile, { recursive: true });
  const conversion = await optionalCommand('libreoffice', [`-env:UserInstallation=${pathToFileURL(profile).href}`, '--headless', '--convert-to', 'pdf', '--outdir', office, docx], root, signal, 180_000); attempts.push(conversion);
  const pdf = join(office, `${basename(docx, extname(docx))}.pdf`);
  if (conversion.exitCode !== 0) { warnings.push({ code: 'reference_render_failed', severity: 'warning', message: 'LibreOffice could not create reference pages.' }); return; }
  const reference = join(bundle, 'reference'); await mkdir(reference, { recursive: true });
  const raster = await optionalCommand('pdftoppm', ['-png', '-r', '96', '-f', '1', '-l', String(Math.max(1, Math.min(60, pages))), pdf, join(reference, 'page')], root, signal, 180_000); attempts.push(raster);
  if (raster.exitCode !== 0) warnings.push({ code: 'reference_thumbnail_failed', severity: 'warning', message: 'PDF reference pages were created but could not be rasterized.' });
}

export async function convertDocx(body: Buffer, options: ConversionOptions): Promise<OperationResult> {
  const root = await mkdtemp(join(tmpdir(), 'afterdraft-docx-')), input = join(root, 'source.docx'), bundle = join(root, 'bundle'); await mkdir(bundle); await writeFile(input, body, { mode: 0o600 });
  try {
    const inventory = await inventoryDocx(input), warnings = [...inventory.warnings], attempts: Attempt[] = [];
    const titleProbe = await runCommand('pandoc', [input, '--from=docx+styles', '--to=plain', '--wrap=none', '--track-changes=accept'], { cwd: bundle, signal: options.signal, timeoutMs: 180_000, allowFailure: true }); attempts.push(cleanAttempt(titleProbe));
    const visibleTitle = titleProbe.exitCode === 0 ? titleProbe.stdout.split(/\r?\n/).map(line => line.trim()).find(Boolean)?.slice(0, 500) : undefined;
    const pageTitle = inventory.metadata.title || visibleTitle || basename(options.filename, extname(options.filename)).trim() || 'Imported document';
    const pandoc = await runCommand('pandoc', [input, '--from=docx+styles', '--to=html5', '--standalone', '--mathml', '--wrap=none', '--track-changes=accept', '--metadata', `pagetitle=${pageTitle}`, '--extract-media=assets', '--output=document.html'], { cwd: bundle, signal: options.signal, timeoutMs: 180_000 }); attempts.push(cleanAttempt(pandoc));
    await mkdir(join(bundle, 'provenance'), { recursive: true });
    await writeJson(join(bundle, 'provenance', 'zotero-fields.json'), await extractDocxFieldProvenance(input));
    const metadataAttempt = await optionalCommand('pandoc', [input, '--from=docx+styles+citations', '--to=json', '--output', join(bundle, 'provenance', 'pandoc-citations.json')], bundle, options.signal, 180_000);
    attempts.push(metadataAttempt);
    if (metadataAttempt.exitCode !== 0) warnings.push({ code: 'pandoc_citation_metadata_fallback', severity: 'info', message: 'This Pandoc version cannot decode DOCX citation fields; raw Zotero field provenance was preserved from OOXML instead.' });
    if (options.includeReference) await referenceThumbnails(input, root, bundle, options.referencePages ?? 60, warnings, attempts, options.signal);
    const outputInventory = inventoryConvertedHtml(await readFile(join(bundle, 'document.html'), 'utf8'));
    if (outputInventory.rawZoteroFieldCodes) throw new WorkerError('unsafe_conversion', 'The converted HTML contains raw Zotero field codes.', 422);
    const expectedMathObjects = inventory.math.inlineObjects + inventory.math.displayGroups;
    if (outputInventory.mathObjects !== expectedMathObjects) warnings.push({ code: 'formula_count_mismatch', severity: 'warning', message: 'The converted formula count differs from the OOXML inline-object and display-group inventory.', evidence: { sourceObjects: inventory.math.objects, expectedConverted: expectedMathObjects, converted: outputInventory.mathObjects } });
    if (outputInventory.images !== inventory.drawings) warnings.push({ code: 'figure_count_mismatch', severity: 'warning', message: 'The converted image count differs from the OOXML drawing inventory.', evidence: { source: inventory.drawings, converted: outputInventory.images } });
    if (outputInventory.tables !== inventory.tables) warnings.push({ code: 'table_count_mismatch', severity: 'warning', message: 'The converted table count differs from the OOXML source inventory.', evidence: { source: inventory.tables, converted: outputInventory.tables } });
    const manifest = { schemaVersion: 1, operation: 'convert', source: { kind: 'docx', filename: safeFilename(options.filename, 'document.docx'), bytes: body.byteLength, sha256: sha256Bytes(body) }, converter: { selected: 'pandoc', attempts }, output: { entryPath: 'document.html', title: pageTitle, inventory: outputInventory }, inventory, warnings };
    return { root, archivePath: await finalize(root, bundle, manifest, options.signal), downloadName: 'afterdraft-docx-bundle.zip' };
  } catch (error) { await import('node:fs/promises').then(module => module.rm(root, { recursive: true, force: true })); throw error; }
}

async function texFiles(root: string): Promise<string[]> {
  const output: string[] = []; async function walk(directory: string) { for (const item of await readdir(directory, { withFileTypes: true })) { const path = join(directory, item.name); if (item.isDirectory()) await walk(path); else if (item.isFile() && /\.tex$/i.test(item.name)) output.push(path); } } await walk(root); return output;
}
function selectTexEntry(project: string, candidates: string[], sources: ReadonlyMap<string, string>, requested?: string): string {
  if (requested) { const target = resolve(project, requested), root = resolve(project) + sep; if (!target.startsWith(root) || !candidates.includes(target)) throw new WorkerError('invalid_entry', 'Requested TeX entry is absent or unsafe.'); return target; }
  const main = candidates.filter(path => /\\documentclass(?:\[[^\]]*\])?\s*\{/m.test(sources.get(path) ?? ''));
  if (main.length === 1) return main[0]!; const named = candidates.find(path => /^main\.tex$/i.test(basename(path))); if (named) return named;
  if (candidates.length === 1) return candidates[0]!; const entryChoices=candidates.map(path=>relative(project,path).split(sep).join('/')).sort();throw new WorkerError('entry_required',`Choose a TeX entry: ${entryChoices.join(', ')}`,409,{entryChoices});
}
export async function convertTex(body: Buffer, options: ConversionOptions): Promise<OperationResult> {
  const root = await mkdtemp(join(tmpdir(), 'afterdraft-tex-')), project = join(root, 'project'), bundle = join(root, 'bundle'); await mkdir(project); await mkdir(bundle);
  try {
    const archive = body[0] === 0x50 && body[1] === 0x4b;
    if (archive) { const upload = join(root, 'project.zip'); await writeFile(upload, body, { mode: 0o600 }); await scanZip(upload, { extractTo: project }); }
    else await writeFile(join(project, safeFilename(options.filename, 'source.tex')), body, { mode: 0o600 });
    const candidates = await texFiles(project), sources = new Map<string, string>();
    for (const file of candidates) sources.set(file, await readFile(file, 'utf8'));
    const entry = selectTexEntry(project, candidates, sources, options.entry);
    const warnings: AcademicWarning[] = [], attempts: Attempt[] = []; const intermediate = join(root, 'document.xml'), output = join(bundle, 'document.html');
    const first = await optionalCommand('latexml', ['--quiet', `--dest=${intermediate}`, entry], dirname(entry), options.signal, 180_000); attempts.push(first);
    let selected = 'latexml';
    if (first.exitCode === 0) { const post = await optionalCommand('latexmlpost', ['--quiet', '--format=html5', `--dest=${output}`, `--sourcedirectory=${project}`, intermediate], dirname(entry), options.signal, 180_000); attempts.push(post); if (post.exitCode !== 0) selected = 'pandoc'; }
    else selected = 'pandoc';
    if (selected === 'pandoc') { warnings.push({ code: 'latexml_fallback', severity: 'warning', message: 'LaTeXML failed; Pandoc produced the browsing derivative.' }); const fallback = await runCommand('pandoc', [entry, '--from=latex', '--to=html5', '--standalone', '--mathml', '--wrap=none', `--resource-path=${dirname(entry)}:${project}`, '--extract-media=assets', '--output=document.html'], { cwd: bundle, signal: options.signal, timeoutMs: 180_000 }); attempts.push(cleanAttempt(fallback)); }
    const manifest = { schemaVersion: 1, operation: 'convert', source: { kind: archive ? 'tex-project-zip' : 'tex', filename: safeFilename(options.filename, 'source.tex'), entry: posix.normalize(relative(project, entry).split(sep).join('/')), bytes: body.byteLength, sha256: sha256Bytes(body) }, converter: { selected, attempts }, output: { entryPath: 'document.html' }, warnings };
    return { root, archivePath: await finalize(root, bundle, manifest, options.signal), downloadName: 'afterdraft-tex-bundle.zip' };
  } catch (error) { await import('node:fs/promises').then(module => module.rm(root, { recursive: true, force: true })); throw error; }
}
