import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import * as cheerio from 'cheerio';
import { sanitizeStylesheet } from '../ingest/sanitize.js';
import type { StagedAcademicResult } from './persistence.js';

export interface AcademicOutlineItem {
  ref: string;
  tag: string;
  text: string;
}

const defaultMaximumBytes = 64 * 1024 * 1024;

function dataUrl(mimeType: string, bytes: Buffer): string {
  return `data:${mimeType};base64,${bytes.toString('base64')}`;
}

function encodedLength(mimeType: string, bytes: number): number {
  return `data:${mimeType};base64,`.length + Math.ceil(bytes / 3) * 4;
}

function occurrences(value: string, search: string): number {
  if (!search) return 0;
  let count = 0, offset = 0;
  while ((offset = value.indexOf(search, offset)) >= 0) { count++; offset += search.length; }
  return count;
}

/**
 * Build the credential-free renderer input. The staged preview is already
 * sanitized; this function only replaces authenticated job-asset URLs with
 * bounded data URLs so the worker can keep every external request disabled.
 */
export async function writeSelfContainedPreview(
  jobId: string,
  previewPath: string,
  staged: StagedAcademicResult,
  outputPath: string,
  maximumBytes = defaultMaximumBytes,
): Promise<{ path: string; bytes: number; sha256Input: Buffer }> {
  let html = await readFile(previewPath, 'utf8');
  const minimumProjected = Buffer.byteLength(html) + staged.assets.reduce(
    (total, asset) => total + encodedLength(asset.mimeType, asset.bytes),
    0,
  );
  if (minimumProjected > maximumBytes) {
    throw new Error('Self-contained render input exceeds 64 MB');
  }
  const encoded = new Map<string, string>();
  for (const asset of staged.assets.filter(item => item.mimeType !== 'text/css')) {
    const bytes = await readFile(asset.storagePath);
    encoded.set(asset.sourcePath, dataUrl(asset.mimeType, bytes));
  }
  for (const asset of staged.assets.filter(item => item.mimeType === 'text/css')) {
    let insertedBytes = 0, exceeded = false;
    const css = sanitizeStylesheet(
      await readFile(asset.storagePath, 'utf8'),
      asset.sourcePath,
      target => {
        const replacement = encoded.get(target);
        if (!replacement) return null;
        insertedBytes += replacement.length;
        if (insertedBytes + Buffer.byteLength(html) > maximumBytes) { exceeded = true; return null; }
        return replacement;
      },
    );
    if (exceeded || Buffer.byteLength(css) > maximumBytes) {
      throw new Error('Self-contained render input exceeds 64 MB');
    }
    encoded.set(asset.sourcePath, dataUrl('text/css', Buffer.from(css)));
  }

  for (const asset of staged.assets) {
    const url = `/api/import-jobs/${jobId}/assets/${asset.id}`;
    const replacement = encoded.get(asset.sourcePath) ?? '', count = occurrences(html, url);
    if (Buffer.byteLength(html) + count * Math.max(0, replacement.length - url.length) > maximumBytes) {
      throw new Error('Self-contained render input exceeds 64 MB');
    }
    html = html.replaceAll(url, replacement);
  }
  await mkdir(dirname(outputPath), { recursive: true, mode: 0o700 });
  const bytes = Buffer.from(html);
  if (bytes.byteLength > maximumBytes) throw new Error('Self-contained render input exceeds 64 MB');
  await writeFile(outputPath, bytes, { mode: 0o600 });
  return { path: outputPath, bytes: bytes.byteLength, sha256Input: bytes };
}

export function academicOutline(html: string, maximum = 2_000): AcademicOutlineItem[] {
  const $ = cheerio.load(html);
  $('script,style,annotation,annotation-xml').remove();
  const result: AcademicOutlineItem[] = [];
  $('[data-block-id]').each((_index, element) => {
    if (result.length >= maximum) return false;
    const node = $(element);
    if (node.parents('[data-block-id]').length && !['img', 'svg', 'video', 'math'].includes(element.tagName)) return;
    const ref = node.attr('data-block-id');
    if (!ref) return;
    const text = (element.tagName === 'img' ? node.attr('alt') : node.attr('alttext') ?? node.attr('aria-label') ?? node.text())
      ?.replace(/\s+/g, ' ')
      .trim()
      .slice(0, 4_000) ?? '';
    result.push({ ref, tag: element.tagName, text });
  });
  return result;
}

export function visibleAcademicText(outline: AcademicOutlineItem[]): string {
  return outline.filter(item => item.text).map(item => `[${item.ref}] <${item.tag}> ${item.text}`).join('\n\n');
}
