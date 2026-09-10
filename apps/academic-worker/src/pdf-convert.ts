import { copyFile, mkdir, mkdtemp, open, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, extname, join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';

import type { OperationResult } from './convert.js';
import { WorkerError } from './errors.js';
import { assertFileWithinWorkerOutputLimit, bundleFiles, createZip, sha256Bytes, writeJson } from './files.js';
import { hasPdfHeader } from './pdf.js';
import { runCommand, type CommandResult } from './process.js';

export const pdfConversionPageLimit = 100;
export const pdfConversionInputLimit = 100 * 1024 * 1024;
const htmlOutputLimit = 10 * 1024 * 1024, pageImageLimit = 64 * 1024 * 1024, pdfObjectLimit = 400;

type Attempt = { tool: string; args: string[]; exitCode: number; durationMs: number; stderr?: string };
export type PdfInfo = { pages: number; title?: string; encrypted: boolean };
type PdfFont = { id: string; size: number; family: string };
export type PdfTextSpan = { id: string; page: number; top: number; left: number; width: number; height: number; fontId: string; fontSize: number; text: string };
export type PdfImageObject = { id: string; page: number; top: number; left: number; width: number; height: number; source: string };
export type PdfLayoutPage = { number: number; width: number; height: number; spans: PdfTextSpan[]; images: PdfImageObject[] };
export type PdfLayout = { fonts: PdfFont[]; pages: PdfLayoutPage[] };
type ReadingBlock = {
  id: string; page: number; top: number; left: number; right: number; bottom: number;
  lane: 'left' | 'middle' | 'right' | 'full'; fontSize: number; text: string; spanIds: string[];
  kind: 'heading' | 'paragraph' | 'caption' | 'list';
};
type PublishedObject = PdfImageObject & { assetPath: string; caption?: ReadingBlock };
type AcademicWarning = { code: string; severity: 'info' | 'warning' | 'error'; message: string; evidence?: Record<string, unknown> };

function attempt(result: CommandResult): Attempt {
  return { tool: result.command, args: result.args, exitCode: result.exitCode, durationMs: result.durationMs, ...(result.stderr.trim() ? { stderr: result.stderr.trim().slice(-2_000) } : {}) };
}
function safeFilename(value: string): string { return basename(value || 'paper.pdf').replace(/[^\p{L}\p{N}._ -]/gu, '_').slice(0, 180) || 'paper.pdf' }
function field(source: string, name: string): string | undefined { return source.match(new RegExp(`^${name}:\\s*(.*?)\\s*$`, 'mi'))?.[1]?.trim() }

export function parsePdfInfo(source: string): PdfInfo {
  const pages = Number(field(source, 'Pages') ?? 0);
  if (!Number.isInteger(pages) || pages < 1) throw new WorkerError('invalid_pdf', 'PDF metadata does not contain a valid page count.', 422);
  if (pages > pdfConversionPageLimit) throw new WorkerError('pdf_page_limit_exceeded', `PDF contains ${pages} pages; complete PDF conversion is limited to ${pdfConversionPageLimit} pages and will not truncate the source.`, 422, { pages, pageLimit: pdfConversionPageLimit });
  const encrypted = /^(?:yes|true)(?:\s|$)/i.test(field(source, 'Encrypted') ?? '');
  if (encrypted) throw new WorkerError('encrypted_pdf', 'Encrypted or password-protected PDFs are not supported.', 422);
  const rawTitle = field(source, 'Title');
  const title = rawTitle && !/^(?:untitled|none|null|unknown)$/i.test(rawTitle) ? rawTitle.replace(/\s+/g, ' ').slice(0, 500) : undefined;
  return { pages, ...(title ? { title } : {}), encrypted };
}

function attribute(source: string, name: string): string | undefined {
  const match = source.match(new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i'));
  return match?.[1] ?? match?.[2];
}
function numberAttribute(source: string, name: string, fallback = 0): number {
  const value = Number(attribute(source, name)); return Number.isFinite(value) ? value : fallback;
}
export function repairTrackedLetters(value: string): string {
  const normalized = value.normalize('NFKC').replace(/[\u00ad\u200b]/g, '');
  const parts = normalized.split(/\s{2,}/).map(part => part.trim()).filter(Boolean);
  const tokens = normalized.trim().split(/\s+/).filter(Boolean);
  if(parts.length===1&&tokens.length>=2&&tokens.every(part=>/^\p{Lu}$/u.test(part)))return tokens.join('');
  if (tokens.length < 4 || tokens.filter(part => /^\p{L}$/u.test(part)).length / tokens.length < 0.7) return normalized;
  if (parts.length > 1) return parts.map(part => part.replace(/(?<=\p{L})\s+(?=\p{L}(?:\s|$))/gu, '')).join(' ');
  return normalized.replace(/(?<=\p{L})\s+(?=\p{L}(?:\s|$))/gu, '');
}
function decodeXml(source: string): string {
  const decoded = source.replace(/<br\s*\/?\s*>/gi, ' ').replace(/<[^>]*>/g, '')
    .replace(/&#x([0-9a-f]+);/gi, (_all, value: string) => String.fromCodePoint(Number.parseInt(value, 16)))
    .replace(/&#(\d+);/g, (_all, value: string) => String.fromCodePoint(Number(value)))
    .replace(/&nbsp;/gi, ' ').replace(/&quot;/gi, '"').replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&amp;/gi, '&');
  return repairTrackedLetters(decoded).replace(/\s+/g, ' ').replace(/\s+([,.;:!?])/g,'$1').trim();
}

export function parsePdfLayoutXml(source: string): PdfLayout {
  const fonts: PdfFont[] = [];
  for (const match of source.matchAll(/<fontspec\b([^>]*)\/?\s*>/gi)) {
    const attrs = match[1] ?? '', id = attribute(attrs, 'id'); if (!id) continue;
    fonts.push({ id, size: numberAttribute(attrs, 'size', 12), family: decodeXml(attribute(attrs, 'family') ?? '') });
  }
  const fontById = new Map(fonts.map(item => [item.id, item])), pages: PdfLayoutPage[] = [];
  for (const match of source.matchAll(/<page\b([^>]*)>([\s\S]*?)<\/page>/gi)) {
    const attrs = match[1] ?? '', body = match[2] ?? '', number = numberAttribute(attrs, 'number', pages.length + 1);
    const width = numberAttribute(attrs, 'width'), height = numberAttribute(attrs, 'height');
    if (!Number.isInteger(number) || number < 1 || width <= 0 || height <= 0) continue;
    const spans: PdfTextSpan[] = [], images: PdfImageObject[] = []; let spanOrdinal = 0, imageOrdinal = 0;
    for (const text of body.matchAll(/<text\b([^>]*)>([\s\S]*?)<\/text>/gi)) {
      const textAttrs = text[1] ?? '', value = decodeXml(text[2] ?? ''); if (!value) continue;
      const fontId = attribute(textAttrs, 'font') ?? '', fontSize = fontById.get(fontId)?.size ?? numberAttribute(textAttrs, 'height', 12);
      spans.push({ id: `p${String(number).padStart(3, '0')}-t${String(++spanOrdinal).padStart(5, '0')}`, page: number, top: numberAttribute(textAttrs, 'top'), left: numberAttribute(textAttrs, 'left'), width: numberAttribute(textAttrs, 'width'), height: numberAttribute(textAttrs, 'height', fontSize), fontId, fontSize, text: value });
    }
    for (const image of body.matchAll(/<image\b([^>]*)\/?\s*>/gi)) {
      const imageAttrs = image[1] ?? '', objectSource = decodeXml(attribute(imageAttrs, 'src') ?? ''); if (!objectSource) continue;
      images.push({ id: `p${String(number).padStart(3, '0')}-i${String(++imageOrdinal).padStart(4, '0')}`, page: number, top: numberAttribute(imageAttrs, 'top'), left: numberAttribute(imageAttrs, 'left'), width: numberAttribute(imageAttrs, 'width'), height: numberAttribute(imageAttrs, 'height'), source: objectSource });
    }
    pages.push({ number, width, height, spans, images });
  }
  return { fonts, pages: pages.sort((left, right) => left.number - right.number) };
}

function median(values: number[], fallback = 12): number {
  if (!values.length) return fallback;
  const sorted = [...values].sort((left, right) => left - right), middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}
type ColumnLayout = { centers: number[] };
function columnLayout(page: PdfLayoutPage): ColumnLayout {
  const useful = page.spans.filter(span => span.text.length > 2 && span.width < page.width * 0.42 && span.top > page.height * 0.06 && span.top < page.height * 0.94);
  const candidates = useful.map(span => span.left + span.width / 2).sort((left, right) => left - right);
  if (candidates.length < 8) return { centers: [] };
  const clusters: number[][] = [];
  for (const center of candidates) {
    const cluster = clusters.at(-1);
    if (!cluster || center - median(cluster) > page.width * 0.18) clusters.push([center]);
    else cluster.push(center);
  }
  const centers = clusters.filter(cluster => cluster.length >= 4).map(cluster => median(cluster)).slice(0, 3);
  return centers.length >= 2 ? { centers } : { centers: [] };
}
function laneFor(span: PdfTextSpan, page: PdfLayoutPage, layout = columnLayout(page)): ReadingBlock['lane'] {
  if (layout.centers.length < 2) return 'full';
  const right = span.left + span.width;
  if ((span.left < layout.centers[0]! && right > layout.centers.at(-1)!) || span.width > page.width * 0.4) return 'full';
  const center = span.left + span.width / 2;
  const nearest = layout.centers.map((value, index) => ({ index, distance: Math.abs(value - center) })).sort((a, b) => a.distance - b.distance)[0]!.index;
  return layout.centers.length === 3 ? (['left', 'middle', 'right'] as const)[nearest]! : nearest === 0 ? 'left' : 'right';
}
function spatialCompare(left:PdfTextSpan,right:PdfTextSpan):number{
  const sameLine=Math.abs(left.top-right.top)<=Math.max(2,Math.min(left.height,right.height)*0.35);
  return sameLine?left.left-right.left||left.top-right.top:left.top-right.top||left.left-right.left;
}
function orderedSpans(page: PdfLayoutPage): Array<PdfTextSpan & { lane: ReadingBlock['lane'] }> {
  const layout = columnLayout(page), items = page.spans.map(span => ({ ...span, lane: laneFor(span, page, layout) }));
  if (layout.centers.length < 2) return items.sort(spatialCompare);
  const full = items.filter(item => item.lane === 'full').sort(spatialCompare), result: Array<PdfTextSpan & { lane: ReadingBlock['lane'] }> = [];
  let boundary = -Infinity;
  for (const separator of [...full, undefined]) {
    const end = separator?.top ?? Infinity, region = items.filter(item => item.lane !== 'full' && item.top >= boundary && item.top < end);
    result.push(...region.filter(item => item.lane === 'left').sort(spatialCompare));
    result.push(...region.filter(item => item.lane === 'middle').sort(spatialCompare));
    result.push(...region.filter(item => item.lane === 'right').sort(spatialCompare));
    if (separator) result.push(separator); boundary = end;
  }
  return result;
}
function isCaption(value: string): boolean { return /^\s*(?:fig(?:ure)?\.?|table)\s+(?:[A-Za-z]*\d+|[IVXLCDM]+)(?:[.\s:：]|$)/i.test(value) }
function isList(value: string): boolean { return /^\s*(?:[•●▪◦‣⁃]|[-–—]\s|\(?(?:\d{1,3}|[A-Za-z])[.)]\s)/.test(value) }
function joinText(left: string, right: string): string {
  if (!left) return right; if (!right) return left;
  if(/[–—]$/.test(left)&&/^\p{L}/u.test(right))return`${left}${right}`;
  if(/[-‐‑]$/.test(left)&&/^\p{L}/u.test(right)){
    if(/^\p{Lu}/u.test(right))return`${left}${right}`;
    const token=left.match(/([\p{L}]+)[-‐‑]$/u)?.[1]?.toLocaleLowerCase(),next=right.match(/^(\p{L}+)/u)?.[1]?.toLocaleLowerCase(),preserve=new Set(['four:color','machine:readable','step:by','day:to','large:scale','small:scale','high:level','low:level','long:term','short:term','real:time','open:source','general:purpose','half:page','full:time','part:time','world:class','state:of','human:centric','sphere:packing']);
    return preserve.has(`${token}:${next}`)?`${left}${right}`:`${left.slice(0,-1)}${right}`;
  }
  return `${left} ${right}`;
}

export function readingBlocks(page: PdfLayoutPage): ReadingBlock[] {
  const spans = orderedSpans(page), baseSize = median(spans.map(span => span.fontSize).filter(size => size > 0)), blocks: ReadingBlock[] = [];
  for (const span of spans) {
    const caption = isCaption(span.text), heading = !caption && span.text.length > 1 && span.text.length <= 240 && (span.fontSize >= baseSize * 1.22 || /^(?:\d+(?:\.\d+)*\.?\s+)?(?:abstract|introduction|conclusion|references|acknowledg(?:e)?ments?)$/i.test(span.text));
    const kind: ReadingBlock['kind'] = caption ? 'caption' : heading ? 'heading' : isList(span.text) ? 'list' : 'paragraph', previous = blocks.at(-1), gap = previous ? span.top - previous.bottom : Infinity;
    const dropCap = previous && previous.kind === 'paragraph' && (kind === 'paragraph'||kind === 'heading') && previous.text.length === 1 && previous.fontSize > baseSize * 1.5 && previous.bottom >= span.top && previous.left < span.left;
    const inline=previous&&Math.abs(previous.top-span.top)<=Math.max(2,Math.min(previous.bottom-previous.top,span.height)*0.35)&&span.left>=previous.right-Math.max(2,baseSize*0.25);
    const sameStyle = previous&&previous.lane===span.lane&&Math.abs(previous.fontSize-span.fontSize)<=Math.max(1.5,baseSize*0.16)&&(inline||(gap>=-Math.max(previous.bottom-previous.top,span.height)*0.35&&gap<=Math.max(span.height,baseSize)*1.05));
    const merge = previous&&(dropCap||(previous.kind===kind&&(kind==='paragraph'||kind==='heading')&&sameStyle));
    if (merge) { previous.text = dropCap ? `${previous.text}${span.text}` : joinText(previous.text, span.text); if(dropCap){previous.kind=kind;previous.fontSize=span.fontSize}previous.right = Math.max(previous.right, span.left + span.width); previous.bottom = Math.max(previous.bottom, span.top + span.height); previous.spanIds.push(span.id); continue }
    blocks.push({ id: span.id, page: span.page, top: span.top, left: span.left, right: span.left + span.width, bottom: span.top + span.height, lane: span.lane, fontSize: span.fontSize, text: span.text, spanIds: [span.id], kind });
  }
  return blocks;
}

function withoutRecurringChrome(layout: PdfLayout, blocksByPage: Map<number, ReadingBlock[]>): Map<number, ReadingBlock[]> {
  const counts = new Map<string, number>();
  const keyFor = (block: ReadingBlock) => block.text.toLocaleLowerCase().replace(/\p{N}+/gu, '#').replace(/\s+/g, ' ').trim();
  for (const page of layout.pages) for (const block of blocksByPage.get(page.number) ?? []) {
    if ((block.top <= page.height * 0.06 || block.bottom >= page.height * 0.94) && keyFor(block).length >= 2) counts.set(keyFor(block), (counts.get(keyFor(block)) ?? 0) + 1);
  }
  const prose=[...blocksByPage.values()].flat().filter(block=>block.kind==='paragraph').map(block=>block.text).join(' ').toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu,' ').replace(/\s+/g,' ').trim();
  return new Map(layout.pages.map(page => {
    const clean=(blocksByPage.get(page.number) ?? []).filter(block => {
      const inMargin = block.top <= page.height * 0.06 || block.bottom >= page.height * 0.94;
      const normalized=block.text.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu,' ').replace(/\s+/g,' ').trim(),duplicateDisplay=block.kind==='heading'&&normalized.length>=20&&prose.includes(normalized);
      return !duplicateDisplay&&!(inMargin&&/^\d{1,4}$/.test(block.text))&&(!inMargin || (counts.get(keyFor(block)) ?? 0) < 2);
    }),ordered:ReadingBlock[]=[];
    for(const block of clean){
      const previous=ordered.at(-1),columnHyphen=previous&&previous.kind==='paragraph'&&block.kind==='paragraph'&&previous.lane!==block.lane&&/[-‐‑]$/u.test(previous.text)&&/^\p{Ll}/u.test(block.text);
      if(columnHyphen){previous.text=joinText(previous.text,block.text);previous.spanIds.push(...block.spanIds);previous.right=Math.max(previous.right,block.right);previous.bottom=Math.max(previous.bottom,block.bottom)}else ordered.push(block);
    }
    return [page.number,ordered];
  }));
}

const nonTitleText = /^(?:abstract|introduction|keywords?|index terms?|references|acknowledg(?:e)?ments?|\d+|.*replace this line with your manuscript id number.*)$/i;
function titleLine(value: string): boolean {
  return value.length >= 5 && value.length <= 500 && !nonTitleText.test(value) && (value.match(/\p{L}/gu)?.length ?? 0) >= 4;
}
function joinTitleLines(lines: string[]): string {
  return lines.reduce((value, line) => !value ? line : /[-‐‑‒–—]$/.test(value) ? `${value}${line}` : `${value} ${line}`, '').replace(/\s+/g, ' ').trim().slice(0, 500);
}

export function pdfTitleCandidate(layout: PdfLayout, metadataTitle: string | undefined, fallback: string): string {
  const normalizedMetadata = metadataTitle?.replace(/\s+/g, ' ').trim();
  if (normalizedMetadata && titleLine(normalizedMetadata)) return normalizedMetadata.slice(0, 500);
  const first = layout.pages[0], spatial = first ? readingBlocks(first).filter(block => block.top < first.height * 0.42).sort((left, right) => left.top - right.top || left.left - right.left) : [];
  const candidates = spatial.filter(block => block.kind === 'heading' && titleLine(block.text));
  const anchor = [...candidates].sort((left, right) => right.fontSize - left.fontSize || left.top - right.top)[0];
  if (!anchor) return fallback.replace(/\.pdf$/i, '') || 'Imported PDF';
  const anchorCenter = (anchor.left + anchor.right) / 2;
  const similar = candidates.filter(block => Math.abs(block.fontSize - anchor.fontSize) <= Math.max(1.5, anchor.fontSize * 0.12) && Math.abs((block.left + block.right) / 2 - anchorCenter) <= (first?.width ?? 0) * 0.2);
  const anchorIndex = similar.indexOf(anchor), selected = [anchor];
  let previous = anchor;
  for (let index = anchorIndex - 1; index >= 0; index--) {
    const block = similar[index]!, gap = previous.top - block.bottom;
    if (gap < -anchor.fontSize * 0.75 || gap > anchor.fontSize * 1.8) break;
    selected.unshift(block); previous = block;
  }
  previous = anchor;
  for (let index = anchorIndex + 1; index < similar.length; index++) {
    const block = similar[index]!, gap = block.top - previous.bottom;
    if (gap < -anchor.fontSize * 0.75 || gap > anchor.fontSize * 1.8) break;
    selected.push(block); previous = block;
  }
  return joinTitleLines(selected.map(block => block.text)) || (fallback.replace(/\.pdf$/i, '') || 'Imported PDF');
}
function escapeHtml(value: string): string { return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;') }
function overlap(left: { left: number; right: number }, right: { left: number; right: number }): number { return Math.max(0, Math.min(left.right, right.right) - Math.max(left.left, right.left)) }
function reliableObject(object: PdfImageObject, page: PdfLayoutPage): boolean {
  const area = object.width * object.height, pageArea = page.width * page.height, aspect = object.width / object.height;
  return object.width >= 64 && object.height >= 48 && area >= pageArea * 0.015 && area <= pageArea * 0.72 && Number.isFinite(aspect) && aspect >= 0.08 && aspect <= 12;
}
function captionFor(object: PdfImageObject, blocks: ReadingBlock[]): ReadingBlock | undefined {
  const horizontal = { left: object.left, right: object.left + object.width }, maximumDistance = Math.max(60, object.height * 0.35);
  return blocks.filter(block => block.kind === 'caption' && overlap(horizontal, block) >= Math.min(object.width, block.right - block.left) * 0.2)
    .map(block => ({ block, distance: block.top >= object.top + object.height ? block.top - (object.top + object.height) : object.top - block.bottom }))
    .filter(item => item.distance >= -8 && item.distance <= maximumDistance).sort((left, right) => left.distance - right.distance)[0]?.block;
}
async function validImage(path: string): Promise<boolean> {
  const details = await stat(path).catch(() => undefined); if (!details?.isFile() || details.size < 8 || details.size > pageImageLimit) return false;
  const handle = await open(path, 'r');
  try { const header = Buffer.alloc(12), result = await handle.read(header, 0, header.byteLength, 0); return result.bytesRead >= 8 && (header.subarray(0, 2).toString('hex') === 'ffd8' || header.subarray(0, 8).toString('hex') === '89504e470d0a1a0a') } finally { await handle.close() }
}

async function collectObjects(root: string, bundle: string, layout: PdfLayout, blocksByPage: Map<number, ReadingBlock[]>): Promise<{ objects: PublishedObject[]; truncated: boolean }> {
  const output: PublishedObject[] = []; let truncated = false; await mkdir(join(bundle, 'assets'), { recursive: true });
  outer: for (const page of layout.pages) for (const object of page.images.filter(item => reliableObject(item, page))) {
    if (output.length >= pdfObjectLimit) { truncated = true; break outer }
    const generated = resolve(root, basename(object.source)), rootPrefix = resolve(root) + sep;
    if (!generated.startsWith(rootPrefix) || !(await validImage(generated))) continue;
    const extension = extname(generated).toLowerCase(); if (!['.jpg', '.jpeg', '.png'].includes(extension)) continue;
    const assetPath = `assets/pdf-object-p${String(page.number).padStart(3, '0')}-${String(output.length + 1).padStart(3, '0')}${extension === '.jpeg' ? '.jpg' : extension}`;
    await copyFile(generated, join(bundle, assetPath));
    const caption = captionFor(object, blocksByPage.get(page.number) ?? []); output.push({ ...object, assetPath, ...(caption ? { caption } : {}) });
  }
  return { objects: output, truncated };
}

async function collectPageFallbacks(root: string, bundle: string, pageNumbers: number[]): Promise<Map<number, string>> {
  const sourceDirectory = join(root, 'page-renders'), files = await readdir(sourceDirectory);
  const selected = new Set(pageNumbers), generated = files.map(name => ({ name, page: Number(name.match(/^page-(\d+)\.jpg$/i)?.[1] ?? 0) })).filter(item => selected.has(item.page)).sort((left, right) => left.page - right.page);
  if (generated.length !== pageNumbers.length || new Set(generated.map(item => item.page)).size !== pageNumbers.length) throw new WorkerError('incomplete_pdf_render', `Poppler rendered ${generated.length} of ${pageNumbers.length} selected PDF pages; conversion was stopped rather than publishing a truncated article.`, 422);
  const result = new Map<number, string>(); await mkdir(join(bundle, 'assets'), { recursive: true });
  for (const item of generated) {
    const source = join(sourceDirectory, item.name); if (!(await validImage(source))) throw new WorkerError('invalid_render_output', `Poppler produced an invalid page image for page ${item.page}.`, 422);
    const name = `pdf-page-${String(item.page).padStart(3, '0')}.jpg`; await rename(source, join(bundle, 'assets', name)); result.set(item.page, `assets/${name}`);
  }
  return result;
}
function referencePageCount(pageAssets: Map<number, string>, maximum: number): number { return Math.min(pageAssets.size, Math.max(1, Math.min(pdfConversionPageLimit, Math.trunc(maximum)))) }
function headingLevel(block: ReadingBlock, baseSize: number, page: number): 1 | 2 | 3 { if (page === 1 && block.fontSize >= baseSize * 1.55) return 1; return block.fontSize >= baseSize * 1.35 ? 2 : 3 }

export function renderReadingHtml(layout: PdfLayout, title: string, pageAssets: Map<number, string>, blocksByPage: Map<number, ReadingBlock[]>, objects: PublishedObject[]): string {
  const objectByPage = new Map<number, PublishedObject[]>(); for (const object of objects) objectByPage.set(object.page, [...(objectByPage.get(object.page) ?? []), object]);
  const baseSize = median([...blocksByPage.values()].flat().filter(block => block.kind === 'paragraph').map(block => block.fontSize));
  const body = layout.pages.map(page => {
    const blocks = blocksByPage.get(page.number) ?? [], pageObjects = objectByPage.get(page.number) ?? [], consumedCaptions = new Set(pageObjects.flatMap(object => object.caption ? object.caption.spanIds : []));
    const content: string[] = [], objectSlots = new Map<number, PublishedObject[]>();
    for (const object of pageObjects) {
      const captionIndex = object.caption ? blocks.indexOf(object.caption) : -1;
      let slot = captionIndex >= 0 ? captionIndex : blocks.length;
      if (captionIndex < 0) {
        const objectLane = laneFor({ ...object, fontId: '', fontSize: 0, text: '' }, page);
        const sameLane = blocks.map((block, index) => ({ block, index })).filter(item => item.block.lane === objectLane);
        const following = sameLane.find(item => item.block.top >= object.top);
        if (following) slot = following.index;
        else if (sameLane.length) slot = sameLane.at(-1)!.index + 1;
      }
      objectSlots.set(slot, [...(objectSlots.get(slot) ?? []), object]);
    }
    const renderObject = (object: PublishedObject): string => {
      const caption = object.caption?.text, alt = caption ? caption.slice(0, 500) : `Extracted visual from PDF page ${page.number}`;
      return `<figure class="pdf-extracted-object" data-profread-source-ref="pdf:p${String(page.number).padStart(3, '0')}:${object.id}" data-profread-enlargeable><img src="${escapeHtml(object.assetPath)}" alt="${escapeHtml(alt)}" loading="lazy">${caption ? `<figcaption>${escapeHtml(caption)}</figcaption>` : ''}</figure>`;
    };
    for (let index = 0; index <= blocks.length; index++) {
      for (const object of (objectSlots.get(index) ?? []).sort((left, right) => left.top - right.top || left.left - right.left)) content.push(renderObject(object));
      const block = blocks[index]; if (!block || block.spanIds.some(id => consumedCaptions.has(id))) continue;
      const sourceRef = `pdf:p${String(page.number).padStart(3, '0')}:${block.spanIds[0]}-${block.spanIds.at(-1)}`, text = escapeHtml(block.text);
      if (block.kind === 'heading') { const level = headingLevel(block, baseSize, page.number === layout.pages[0]?.number ? 1 : page.number); content.push(`<h${level} data-profread-source-ref="${sourceRef}">${text}</h${level}>`) }
      else if (block.kind === 'caption') content.push(`<p class="pdf-unassociated-caption" data-profread-source-ref="${sourceRef}">${text}</p>`);
      else if (block.kind === 'list') content.push(`<p class="pdf-list-item" data-profread-source-ref="${sourceRef}">${text}</p>`);
      else content.push(`<p data-profread-source-ref="${sourceRef}">${text}</p>`);
    }
    const visualOnly = blocks.reduce((sum, block) => sum + block.text.length, 0) < 40, pageAsset = pageAssets.get(page.number);
    const fallback = pageAsset ? `<details class="pdf-source-page" data-profread-source-ref="pdf:p${String(page.number).padStart(3, '0')}:source-page"><summary>Original PDF page ${page.number}</summary><figure data-profread-enlargeable><img src="${escapeHtml(pageAsset)}" alt="Original PDF page ${page.number}" loading="lazy"><figcaption>Original PDF page ${page.number}</figcaption></figure></details>` : '';
    const notice = visualOnly ? '<p class="pdf-visual-fallback-note">This page has little or no native text. Open the original page image below for the complete visual source.</p>' : '';
    return `<section class="pdf-page" data-pdf-page="${page.number}" aria-label="PDF page ${page.number}">${notice}${content.join('\n')}${fallback}</section>`;
  }).join('\n');
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escapeHtml(title)}</title><style>.profread-pdf{max-width:72rem;margin:auto}.pdf-page{margin:0 0 3rem}.pdf-page+.pdf-page{padding-top:2rem;border-top:1px solid #d8d4ca}.pdf-extracted-object{margin:1.5rem auto}.pdf-source-page{margin:2rem 0;padding:.6rem;border:1px solid #d8d4ca;background:#f8f6ef}.pdf-source-page>summary{cursor:pointer;font:600 .85rem ui-sans-serif,system-ui,sans-serif}.pdf-source-page figure{margin:1rem 0 0}.pdf-source-page img{display:block;width:100%;height:auto}.pdf-visual-fallback-note,.pdf-unassociated-caption{color:#5d5a52;font-size:.9em}.pdf-list-item{padding-left:1.25rem}</style></head><body><article class="profread-pdf">${body}</article></body></html>`;
}

async function finalize(root: string, bundle: string, manifest: Record<string, unknown>, signal?: AbortSignal): Promise<string> {
  const files = await bundleFiles(bundle); manifest.files = files; manifest.provenanceFiles = files.filter(file => file.path.startsWith('provenance/')); await writeJson(join(bundle, 'manifest.json'), manifest);
  const archive = join(root, 'result.zip'); await createZip(bundle, archive, signal); await assertFileWithinWorkerOutputLimit(archive, 'Converted PDF bundle exceeds the worker response limit.'); return archive;
}

export async function convertPdf(body: Buffer, options: { filename: string; includeReference?: boolean; referencePages?: number; pageStart?: number; pageEnd?: number; title?: string; signal?: AbortSignal }): Promise<OperationResult> {
  if (body.byteLength > pdfConversionInputLimit) throw new WorkerError('body_too_large', 'PDF source exceeds the 100 MiB conversion limit.', 413);
  if (!hasPdfHeader(body)) throw new WorkerError('invalid_pdf', 'The source does not start with a PDF header.', 422);
  const root = await mkdtemp(join(tmpdir(), 'profread-pdf-convert-')), input = join(root, 'source.pdf'), bundle = join(root, 'bundle'), pageRenders = join(root, 'page-renders');
  await mkdir(bundle, { recursive: true }); await mkdir(pageRenders, { recursive: true }); await writeFile(input, body, { mode: 0o600 });
  try {
    const attempts: Attempt[] = [], infoResult = await runCommand('pdfinfo', [input], { cwd: root, signal: options.signal, timeoutMs: 30_000 }); attempts.push(attempt(infoResult)); const info = parsePdfInfo(infoResult.stdout), layoutPath = join(root, 'layout.xml');
    const pageStart = options.pageStart ?? 1, pageEnd = options.pageEnd ?? info.pages;
    if (!Number.isInteger(pageStart) || !Number.isInteger(pageEnd) || pageStart < 1 || pageEnd < pageStart || pageEnd > info.pages) throw new WorkerError('invalid_page_range', `Selected PDF page range ${pageStart}–${pageEnd} is outside this ${info.pages}-page source.`, 422, { pageStart, pageEnd, pageCount: info.pages });
    const pageNumbers = Array.from({ length: pageEnd - pageStart + 1 }, (_value, index) => pageStart + index), rangeArgs = ['-f', String(pageStart), '-l', String(pageEnd)];
    const layoutResult = await runCommand('pdftohtml', ['-xml', '-hidden', '-enc', 'UTF-8', ...rangeArgs, input, layoutPath], { cwd: root, signal: options.signal, timeoutMs: 300_000 }); attempts.push(attempt(layoutResult));
    const rasterResult = await runCommand('pdftoppm', ['-jpeg', '-jpegopt', 'quality=86,optimize=y,progressive=y', '-r', '144', '-scale-to', '3000', ...rangeArgs, input, join(pageRenders, 'page')], { cwd: root, signal: options.signal, timeoutMs: 600_000 }); attempts.push(attempt(rasterResult));
    const layout = parsePdfLayoutXml(await readFile(layoutPath, 'utf8'));
    if (layout.pages.length !== pageNumbers.length || layout.pages.some((page, index) => page.number !== pageNumbers[index])) throw new WorkerError('incomplete_pdf_extraction', `Poppler extracted layout for ${layout.pages.length} of ${pageNumbers.length} selected pages; conversion was stopped rather than publishing a truncated article.`, 422);
    const blocksByPage = withoutRecurringChrome(layout, new Map(layout.pages.map(page => [page.number, readingBlocks(page)]))), pageAssets = await collectPageFallbacks(root, bundle, pageNumbers), extractedObjects = await collectObjects(root, bundle, layout, blocksByPage), objects = extractedObjects.objects;
    const referencePages = options.includeReference ? referencePageCount(pageAssets, options.referencePages ?? 60) : 0, filename = safeFilename(options.filename), title = options.title?.trim().slice(0, 500) || pdfTitleCandidate(layout, info.title, filename);
    const html = renderReadingHtml(layout, title, pageAssets, blocksByPage, objects); if (Buffer.byteLength(html) > htmlOutputLimit) throw new WorkerError('output_too_large', 'Converted PDF HTML exceeds the 10 MiB document limit.', 422); await writeFile(join(bundle, 'document.html'), html, { mode: 0o600, flag: 'wx' });
    const textPages = layout.pages.filter(page => (blocksByPage.get(page.number) ?? []).reduce((sum, block) => sum + block.text.length, 0) >= 40).map(page => page.number), visualFallbackPages = layout.pages.map(page => page.number).filter(page => !textPages.includes(page));
    const warnings: AcademicWarning[] = [
      { code: 'pdf_page_fallbacks_included', severity: 'info', message: `Included a folded 144-DPI source image for all ${pageNumbers.length} selected pages so visible content remains available when PDF semantics are incomplete.`, evidence: { pages: pageNumbers, dpi: 144 } },
      ...(visualFallbackPages.length ? [{ code: 'pdf_native_text_missing', severity: 'warning' as const, message: `${visualFallbackPages.length} page${visualFallbackPages.length === 1 ? '' : 's'} had little or no native text and use visual fallback.`, evidence: { pages: visualFallbackPages } }] : []),
      ...(objects.length ? [{ code: 'pdf_objects_extracted', severity: 'info' as const, message: `Placed ${objects.length} reliably bounded raster object${objects.length === 1 ? '' : 's'} in the reading view; vector and composite objects remain available in source-page fallbacks.`, evidence: { objects: objects.length } }] : []),
      ...(extractedObjects.truncated ? [{ code: 'pdf_object_limit_reached', severity: 'warning' as const, message: `Stopped publishing separate raster objects after the ${pdfObjectLimit}-object safety limit; every object remains visible in its folded source-page fallback.`, evidence: { objectLimit: pdfObjectLimit } }] : []),
      ...(referencePages && referencePages < pageNumbers.length ? [{ code: 'reference_pages_sampled', severity: 'info' as const, message: `Prepared ${referencePages} of ${pageNumbers.length} selected source pages as optional QA evidence.`, evidence: { selectedPages: pageNumbers, referencePages } }] : []),
      { code: 'pdf_semantics_limited', severity: 'warning', message: 'PDF glyphs do not preserve authoritative equation, table, citation, alt-text, or tracked-change semantics. Uncertain content remains visual rather than being reconstructed.' },
    ];
    await writeJson(join(bundle, 'provenance', 'pdf-layout.json'), {
      schemaVersion: 1,
      pages: layout.pages.map(page => ({ number: page.number, width: page.width, height: page.height, spans: page.spans, images: page.images })),
      readingOrder: layout.pages.map(page => ({ page: page.number, blockSpanIds: (blocksByPage.get(page.number) ?? []).map(block => block.spanIds) })),
      extractedObjects: objects.map(object => ({ id: object.id, page: object.page, top: object.top, left: object.left, width: object.width, height: object.height, assetPath: object.assetPath, captionSpanIds: object.caption?.spanIds ?? [] })),
    });
    const inventory = { pages: info.pages, sourcePages: info.pages, selectedPages: pageNumbers.length, selectedPageStart: pageStart, selectedPageEnd: pageEnd, nativeTextPages: textPages.length, visualFallbackPages: visualFallbackPages.length, textSpans: layout.pages.reduce((sum, page) => sum + page.spans.length, 0), readingBlocks: [...blocksByPage.values()].reduce((sum, blocks) => sum + blocks.length, 0), extractedObjects: objects.length, objectExtractionTruncated: extractedObjects.truncated, pageFallbacks: pageAssets.size, referencePages };
    const manifest: Record<string, unknown> = {
      schemaVersion: 1, operation: 'convert',
      source: {
        kind: 'pdf', filename, bytes: body.byteLength, sha256: sha256Bytes(body),
        contentType: 'application/pdf', pages: info.pages, pageCount: info.pages, convertedPageCount: layout.pages.length, selectedPageStart: pageStart, selectedPageEnd: pageEnd,
        textMode: visualFallbackPages.length === pageNumbers.length ? 'visual-fallback' : visualFallbackPages.length ? 'hybrid' : 'native',
        assetCount: pageAssets.size + objects.length, fallbackUsed: pageAssets.size > 0,
      },
      converter: { selected: 'poppler-hybrid-pdf', revision: '1', attempts },
      inventory,
      output: { entryPath: 'document.html', title, inventory },
      warnings,
    };
    return { root, archivePath: await finalize(root, bundle, manifest, options.signal), downloadName: 'profread-pdf-bundle.zip' };
  } catch (error) { await rm(root, { recursive: true, force: true }); throw error }
}

export type ArticleRangeSuggestion = {
  startPage: number;
  endPage: number;
  confidence: 'high' | 'low';
  source: 'local';
  rationale: string;
  evidencePages: number[];
};

function articleTokens(value: string): string[] {
  return repairTrackedLetters(value).normalize('NFKC').toLocaleLowerCase().replace(/[-‐‑‒–—]/g, ' ').match(/[\p{L}\p{N}]+/gu) ?? [];
}

function orderedTitleCoverage(pageText: string, title: string): number {
  const haystack = articleTokens(pageText), needles = articleTokens(title);
  if (!needles.length) return 0;
  let found = 0, cursor = 0;
  for (const needle of needles) {
    const index = haystack.indexOf(needle, cursor);
    if (index < 0) continue;
    found++; cursor = index + 1;
  }
  return found / needles.length;
}

export function detectArticleRange(layout: PdfLayout, title: string): { suggestion?: ArticleRangeSuggestion; pages: Array<{ page: number; textLength: number; excerpt: string; titleCoverage: number }> } {
  const summaries = layout.pages.map(page => {
    const text = readingBlocks(page).map(block => block.text).join(' ').replace(/\s+/g, ' ').trim();
    const sizes=page.spans.map(span=>span.fontSize).filter(size=>size>0).sort((left,right)=>left-right),baseSize=sizes[Math.floor((sizes.length-1)*0.3)]??12,titleSet=new Set(articleTokens(title)),relevant=page.spans.filter(span=>articleTokens(span.text).some(token=>titleSet.has(token)));
    const titleScale=Math.max(0,...relevant.map(span=>span.fontSize))/baseSize,prominentText=page.spans.filter(span=>span.fontSize>=baseSize*1.35).sort((left,right)=>left.top-right.top||left.left-right.left).map(span=>span.text).join(' ');
    const fullCoverage=orderedTitleCoverage(text,title),prominentCoverage=orderedTitleCoverage(prominentText,title),titleCoverage=titleScale>=1.7?Math.max(fullCoverage,prominentCoverage):fullCoverage*0.75;
    return { page: page.number, textLength: text.length, excerpt: text.slice(0, 700), titleCoverage };
  });
  const matches = summaries.filter(page => page.titleCoverage >= 0.9);
  if (matches.length !== 1) return { pages: summaries };
  const start = matches[0]!, startIndex = summaries.indexOf(start);
  let bodyPages = 0, endPage = summaries.at(-1)?.page ?? start.page, boundaryFound = false;
  for (let index = startIndex + 1; index < summaries.length; index++) {
    const page = summaries[index]!;
    if (page.textLength >= 1_200) bodyPages++;
    const permittedVisualPage = index === startIndex + 1 && page.textLength < 120;
    if (!permittedVisualPage && bodyPages >= 2 && page.textLength < 800) {
      endPage = summaries[index - 1]!.page; boundaryFound = true; break;
    }
  }
  return {
    pages: summaries,
    suggestion: {
      startPage: start.page,
      endPage,
      confidence: boundaryFound ? 'high' : 'low',
      source: 'local',
      rationale: boundaryFound
        ? 'Matched the requested title uniquely, kept the adjacent visual page, and stopped before the first low-text page after the article body.'
        : 'Matched the requested title uniquely, but did not find a strong ending boundary.',
      evidencePages: [start.page, endPage],
    },
  };
}

export async function inspectPdf(body: Buffer, options: { filename: string; title: string; signal?: AbortSignal }): Promise<OperationResult> {
  if (body.byteLength > pdfConversionInputLimit) throw new WorkerError('body_too_large', 'PDF source exceeds the 100 MiB inspection limit.', 413);
  if (!hasPdfHeader(body)) throw new WorkerError('invalid_pdf', 'The source does not start with a PDF header.', 422);
  const root = await mkdtemp(join(tmpdir(), 'profread-pdf-inspect-')), input = join(root, 'source.pdf'), bundle = join(root, 'bundle'), renders = join(root, 'page-renders');
  await mkdir(bundle, { recursive: true }); await mkdir(renders, { recursive: true }); await mkdir(join(bundle, 'pages'), { recursive: true }); await writeFile(input, body, { mode: 0o600 });
  try {
    const attempts: Attempt[] = [], infoResult = await runCommand('pdfinfo', [input], { cwd: root, signal: options.signal, timeoutMs: 30_000 }); attempts.push(attempt(infoResult));
    const info = parsePdfInfo(infoResult.stdout), layoutPath = join(root, 'layout.xml');
    const layoutResult = await runCommand('pdftohtml', ['-xml', '-hidden', '-enc', 'UTF-8', input, layoutPath], { cwd: root, signal: options.signal, timeoutMs: 300_000 }); attempts.push(attempt(layoutResult));
    const rasterResult = await runCommand('pdftoppm', ['-jpeg', '-jpegopt', 'quality=78,optimize=y,progressive=y', '-r', '72', '-scale-to', '1200', '-f', '1', '-l', String(info.pages), input, join(renders, 'page')], { cwd: root, signal: options.signal, timeoutMs: 600_000 }); attempts.push(attempt(rasterResult));
    const layout = parsePdfLayoutXml(await readFile(layoutPath, 'utf8'));
    if (layout.pages.length !== info.pages || layout.pages.some((page, index) => page.number !== index + 1)) throw new WorkerError('incomplete_pdf_extraction', 'Could not inspect every PDF page.', 422);
    const detection = detectArticleRange(layout, options.title), pageFiles = await readdir(renders), available = new Map(pageFiles.map(name => [Number(name.match(/^page-(\d+)\.jpg$/i)?.[1] ?? 0), name]));
    const pages = [];
    for (const summary of detection.pages) {
      const name = available.get(summary.page), thumbnailPath = `pages/page-${String(summary.page).padStart(3, '0')}.jpg`;
      if (!name || !(await validImage(join(renders, name)))) throw new WorkerError('incomplete_pdf_render', `Could not render inspection thumbnail for PDF page ${summary.page}.`, 422);
      await rename(join(renders, name), join(bundle, thumbnailPath)); pages.push({ ...summary, thumbnailPath });
    }
    const inspection = { schemaVersion: 1, title: options.title.trim(), pageCount: info.pages, pages, ...(detection.suggestion ? { suggestion: detection.suggestion } : {}) };
    await writeJson(join(bundle, 'inspection.json'), inspection);
    const manifest = {
      schemaVersion: 1, operation: 'inspect',
      source: { kind: 'pdf', filename: safeFilename(options.filename), bytes: body.byteLength, sha256: sha256Bytes(body), contentType: 'application/pdf', pages: info.pages, pageCount: info.pages },
      converter: { selected: 'poppler-pdf-inspector', revision: '1', attempts },
      output: { entryPath: 'inspection.json', title: options.title.trim(), pageCount: info.pages },
      inventory: { pages: info.pages, thumbnails: pages.length }, warnings: [],
    };
    return { root, archivePath: await finalize(root, bundle, manifest, options.signal), downloadName: 'profread-pdf-inspection.zip' };
  } catch (error) { await rm(root, { recursive: true, force: true }); throw error }
}
