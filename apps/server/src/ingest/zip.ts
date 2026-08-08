import yauzl from 'yauzl';
import { promisify } from 'node:util';
import { config } from '../config.js';

const openZip = promisify<Buffer, yauzl.Options, yauzl.ZipFile>(yauzl.fromBuffer);
const supported = new Set(['.html','.htm','.css','.png','.jpg','.jpeg','.gif','.webp','.svg','.woff','.woff2','.ttf','.otf']);
export interface ZipContents { files: Map<string, Buffer>; htmlEntries: string[] }

export async function readSafeZip(buffer: Buffer): Promise<ZipContents> {
  const zip = await openZip(buffer, { lazyEntries: true, decodeStrings: true, validateEntrySizes: true });
  const files = new Map<string, Buffer>(); const htmlEntries: string[] = []; let count = 0; let expanded = 0;
  return await new Promise((resolve, reject) => {
    const fail = (error: Error) => { zip.close(); reject(error); };
    zip.on('error', fail); zip.on('end', () => resolve({ files, htmlEntries }));
    zip.on('entry', entry => {
      count++; const name = entry.fileName.replaceAll('\\', '/');
      const unixMode = (entry.externalFileAttributes >>> 16) & 0xffff;
      if (count > config.limits.entries) return fail(new Error('ZIP has too many entries'));
      if (name.startsWith('/') || name.split('/').includes('..') || /^[A-Za-z]:/.test(name)) return fail(new Error(`Unsafe ZIP path: ${name}`));
      if ((unixMode & 0o170000) === 0o120000) return fail(new Error(`Symlink entries are not allowed: ${name}`));
      if (/\/$/.test(name)) { zip.readEntry(); return; }
      const dot = name.lastIndexOf('.'); const extension = dot >= 0 ? name.slice(dot).toLowerCase() : '';
      if (!supported.has(extension)) return fail(new Error(`Unsupported ZIP entry type: ${name}`));
      expanded += entry.uncompressedSize;
      if (expanded > config.limits.expandedBytes || (entry.compressedSize > 0 && entry.uncompressedSize / entry.compressedSize > 200)) return fail(new Error('ZIP expansion limits exceeded'));
      zip.openReadStream(entry, (error, stream) => {
        if (error || !stream) return fail(error ?? new Error('Could not read ZIP entry'));
        const chunks: Buffer[] = []; let actual = 0;
        stream.on('data', (chunk: Buffer) => { actual += chunk.length; if (actual > entry.uncompressedSize) stream.destroy(new Error('ZIP size mismatch')); else chunks.push(chunk); });
        stream.on('error', fail); stream.on('end', () => { files.set(name, Buffer.concat(chunks)); if (/\.html?$/i.test(name)) htmlEntries.push(name); zip.readEntry(); });
      });
    });
    zip.readEntry();
  });
}
