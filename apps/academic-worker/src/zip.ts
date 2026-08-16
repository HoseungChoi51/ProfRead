import { createWriteStream } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import yauzl from 'yauzl';
import { WorkerError } from './errors.js';

const openZip = promisify<string, yauzl.Options, yauzl.ZipFile>(yauzl.open);
const limits = { entries: 10_000, total: 256 * 1024 * 1024, single: 64 * 1024 * 1024, ratio: 200 };
export interface ZipEntryInfo { name: string; compressedBytes: number; uncompressedBytes: number }
export interface ZipScan { entries: ZipEntryInfo[]; collected: Map<string, Buffer>; totalBytes: number }

function safeName(raw: string): string {
  const name = raw.replaceAll('\\', '/');
  if (!name || name.includes('\0') || name.startsWith('/') || /^[A-Za-z]:/.test(name) || name.split('/').includes('..')) throw new WorkerError('unsafe_archive', `Unsafe ZIP path: ${JSON.stringify(raw)}`);
  return name;
}
function streamFor(zip: yauzl.ZipFile, entry: yauzl.Entry): Promise<NodeJS.ReadableStream> {
  return new Promise((resolveStream, rejectStream) => zip.openReadStream(entry, (error, stream) => error || !stream ? rejectStream(error ?? new Error('Could not read ZIP entry')) : resolveStream(stream)));
}
async function collectStream(stream: NodeJS.ReadableStream, expected: number): Promise<Buffer> {
  const chunks: Buffer[] = []; let bytes = 0;
  for await (const chunk of stream) { const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as unknown as Uint8Array); bytes += value.byteLength; if (bytes > expected) throw new WorkerError('unsafe_archive', 'ZIP entry exceeded its declared size.'); chunks.push(value); }
  if (bytes !== expected) throw new WorkerError('unsafe_archive', 'ZIP entry size mismatch.');
  return Buffer.concat(chunks);
}

export async function scanZip(filePath: string, options: { collect?: (name: string) => boolean; extractTo?: string } = {}): Promise<ZipScan> {
  const zip = await openZip(filePath, { lazyEntries: true, decodeStrings: true, validateEntrySizes: true, autoClose: true });
  const entries: ZipEntryInfo[] = [], collected = new Map<string, Buffer>(), seen = new Set<string>(); let totalBytes = 0;
  return new Promise((resolveScan, rejectScan) => {
    let done = false;
    const fail = (error: unknown) => { if (!done) { done = true; zip.close(); rejectScan(error); } };
    zip.on('error', fail); zip.on('end', () => { if (!done) { done = true; resolveScan({ entries, collected, totalBytes }); } });
    zip.on('entry', entry => { void (async () => {
      const name = safeName(entry.fileName), mode = (entry.externalFileAttributes >>> 16) & 0xffff;
      if (seen.has(name)) throw new WorkerError('unsafe_archive', `Duplicate ZIP entry: ${name}`); seen.add(name);
      if ((mode & 0o170000) === 0o120000) throw new WorkerError('unsafe_archive', `ZIP symlink not allowed: ${name}`);
      if ((entry.generalPurposeBitFlag & 1) !== 0) throw new WorkerError('unsafe_archive', `Encrypted ZIP entry not allowed: ${name}`);
      if (entries.length >= limits.entries || entry.uncompressedSize > limits.single) throw new WorkerError('unsafe_archive', 'ZIP size limits exceeded.');
      if (entry.compressedSize > 0 && entry.uncompressedSize / entry.compressedSize > limits.ratio) throw new WorkerError('unsafe_archive', 'ZIP expansion ratio limit exceeded.');
      totalBytes += entry.uncompressedSize; if (totalBytes > limits.total) throw new WorkerError('unsafe_archive', 'ZIP expansion limit exceeded.');
      entries.push({ name, compressedBytes: entry.compressedSize, uncompressedBytes: entry.uncompressedSize });
      if (name.endsWith('/')) { if (options.extractTo) await mkdir(resolve(options.extractTo, name), { recursive: true }); zip.readEntry(); return; }
      const collect = options.collect?.(name) ?? false;
      if (!options.extractTo && !collect) { zip.readEntry(); return; }
      const stream = await streamFor(zip, entry);
      if (collect) {
        const value = await collectStream(stream, entry.uncompressedSize); collected.set(name, value);
        if (options.extractTo) { const target = resolve(options.extractTo, name), root = resolve(options.extractTo) + sep; if (!target.startsWith(root)) throw new WorkerError('unsafe_archive', 'Unsafe extraction target.'); await mkdir(dirname(target), { recursive: true }); await writeFile(target, value, { mode: 0o600 }); }
      } else {
        const target = resolve(options.extractTo!, name), root = resolve(options.extractTo!) + sep; if (!target.startsWith(root)) throw new WorkerError('unsafe_archive', 'Unsafe extraction target.');
        await mkdir(dirname(target), { recursive: true }); await pipeline(stream, createWriteStream(target, { mode: 0o600 }));
      }
      zip.readEntry();
    })().catch(fail); });
    zip.readEntry();
  });
}
