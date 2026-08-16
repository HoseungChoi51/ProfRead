import { WorkerError } from './errors.js';
import { scanZip, type ZipEntryInfo } from './zip.js';

export interface AcademicWarning { code: string; severity: 'info' | 'warning' | 'error'; message: string; evidence?: Record<string, unknown> }
export interface OoxmlInventory {
  packageEntries: number; expandedBytes: number; paragraphs: number; paragraphIds: number; tables: number;
  drawings: number; inlineDrawings: number; anchoredDrawings: number; media: Array<{ path: string; bytes: number }>;
  math: { objects: number; inlineObjects: number; displayObjects: number; displayGroups: number };
  fields: { complex: number; zoteroCitations: number; zoteroBibliographies: number; sequenceFigures: number; sequenceTables: number };
  revisions: { insertions: number; deletions: number; moves: number }; comments: number; footnotes: number; endnotes: number;
  headers: number; footers: number; sections: number; externalRelationships: number; alternateContent: number; altChunks: number;
  descriptions: { described: number; missing: number }; metadata: { title?: string | undefined; creator?: string | undefined; subject?: string | undefined }; warnings: AcademicWarning[];
}
const collected = new Set(['[Content_Types].xml', 'word/document.xml', 'word/comments.xml', 'word/footnotes.xml', 'word/endnotes.xml', 'word/_rels/document.xml.rels', 'docProps/core.xml']);
const count = (source: string, expression: RegExp) => source.match(expression)?.length ?? 0;
function decodeXml(value?: string): string | undefined { return value?.replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&quot;', '"').replaceAll('&apos;', "'").replaceAll('&amp;', '&').replace(/&#(\d+);/g, (_m, n: string) => String.fromCodePoint(Number(n))).replace(/&#x([0-9a-f]+);/gi, (_m, n: string) => String.fromCodePoint(Number.parseInt(n, 16))).trim(); }
function elementText(source: string, name: string): string | undefined { const match = source.match(new RegExp(`<[^:>]+:${name}\\b[^>]*>([\\s\\S]*?)<\\/[^:>]+:${name}>`, 'i')); return decodeXml(match?.[1]?.replace(/<[^>]+>/g, '')); }
function noteCount(source: string, name: string): number { return [...source.matchAll(new RegExp(`<w:${name}\\b[^>]*w:id="(-?\\d+)"`, 'g'))].filter(match => Number(match[1]) > 0).length; }
function media(entries: ZipEntryInfo[]) { return entries.filter(entry => /^word\/media\//i.test(entry.name) && !entry.name.endsWith('/')).map(entry => ({ path: entry.name, bytes: entry.uncompressedBytes })); }

export async function extractDocxFieldProvenance(filePath: string): Promise<{ schemaVersion: 1; zoteroFields: Array<{ kind: 'citation' | 'bibliography'; instruction: string }> }> {
  const scanned = await scanZip(filePath, { collect: name => name === 'word/document.xml' });
  const document = scanned.collected.get('word/document.xml')?.toString('utf8');
  if (!document) throw new WorkerError('invalid_docx', 'The upload has no Word document body.');
  const zoteroFields = [...document.matchAll(/<w:fldChar\b[^>]*w:fldCharType="begin"[^>]*\/?>([\s\S]*?)<w:fldChar\b[^>]*w:fldCharType="end"[^>]*\/?>/gi)]
    .map(match => [...match[1]!.matchAll(/<w:instrText\b[^>]*>([\s\S]*?)<\/w:instrText>/gi)].map(part => decodeXml(part[1]?.replace(/<[^>]+>/g, '')) ?? '').join(''))
    .filter(instruction => /\bZOTERO_(?:ITEM|BIBL)\b/i.test(instruction))
    .map(instruction => ({ kind: /\bZOTERO_BIBL\b/i.test(instruction) ? 'bibliography' as const : 'citation' as const, instruction }));
  return { schemaVersion: 1, zoteroFields };
}

export async function inventoryDocx(filePath: string): Promise<OoxmlInventory> {
  const scanned = await scanZip(filePath, { collect: name => collected.has(name) });
  const document = scanned.collected.get('word/document.xml')?.toString('utf8');
  if (!document || !scanned.collected.has('[Content_Types].xml')) throw new WorkerError('invalid_docx', 'The upload is not a valid Word OOXML document.');
  const comments = scanned.collected.get('word/comments.xml')?.toString('utf8') ?? '', footnotes = scanned.collected.get('word/footnotes.xml')?.toString('utf8') ?? '', endnotes = scanned.collected.get('word/endnotes.xml')?.toString('utf8') ?? '';
  const rels = scanned.collected.get('word/_rels/document.xml.rels')?.toString('utf8') ?? '', core = scanned.collected.get('docProps/core.xml')?.toString('utf8') ?? '';
  const instructions = [...document.matchAll(/<w:instrText\b[^>]*>([\s\S]*?)<\/w:instrText>/gi)].map(match => decodeXml(match[1]?.replace(/<[^>]+>/g, '')) ?? '').join(' ');
  const drawings = count(document, /<w:drawing\b/gi), described = count(document, /<wp:docPr\b[^>]*\b(?:descr|title)="[^"\s][^"]*"/gi);
  const sequenceFigures = count(instructions, /\bSEQ\s+(?:Figure|Fig\.?)(?:\s|\\|$)/gi);
  const sequenceTables = count(instructions, /\bSEQ\s+Table(?:\s|\\|$)/gi);
  const tableCount = count(document, /<w:tbl\b/gi);
  const mathObjects = count(document, /<m:oMath\b/gi), displayMathGroups = [...document.matchAll(/<m:oMathPara\b[\s\S]*?<\/m:oMathPara>/gi)], displayMathObjects = displayMathGroups.reduce((total, match) => total + count(match[0], /<m:oMath\b/gi), 0);
  const revisions = { insertions: count(document, /<w:ins\b/gi), deletions: count(document, /<w:del\b/gi), moves: count(document, /<w:move(?:From|To)\b/gi) };
  const headers = scanned.entries.filter(entry => /^word\/header\d+\.xml$/i.test(entry.name)).length, footers = scanned.entries.filter(entry => /^word\/footer\d+\.xml$/i.test(entry.name)).length;
  const warnings: AcademicWarning[] = [];
  if (revisions.insertions + revisions.deletions + revisions.moves) warnings.push({ code: 'tracked_changes_accepted', severity: 'warning', message: 'Tracked changes are present; conversion imports Word’s current accepted view.', evidence: revisions });
  if (headers + footers) warnings.push({ code: 'page_chrome_ignored', severity: 'info', message: 'Running headers and footers are excluded from the browsing article.', evidence: { headers, footers } });
  if (drawings > described) warnings.push({ code: 'missing_alt_text', severity: 'warning', message: `${drawings - described} drawing(s) have no Word title or description.`, evidence: { drawings, described } });
  if (sequenceFigures !== drawings || sequenceTables !== tableCount) warnings.push({
    code: 'caption_semantics_inconsistent',
    severity: 'warning',
    message: 'Some figures or tables are not paired with Word sequence fields; review their caption association and numbering.',
    evidence: { drawings, sequenceFigures, tables: tableCount, sequenceTables },
  });
  return {
    packageEntries: scanned.entries.length, expandedBytes: scanned.totalBytes, paragraphs: count(document, /<w:p\b/gi), paragraphIds: count(document, /\bw14:paraId="[0-9A-F]+"/gi), tables: tableCount, drawings,
    inlineDrawings: count(document, /<wp:inline\b/gi), anchoredDrawings: count(document, /<wp:anchor\b/gi), media: media(scanned.entries), math: { objects: mathObjects, inlineObjects: mathObjects - displayMathObjects, displayObjects: displayMathObjects, displayGroups: displayMathGroups.length },
    fields: { complex: count(document, /<w:fldChar\b[^>]*w:fldCharType="begin"/gi), zoteroCitations: count(instructions, /ADDIN\s+ZOTERO_ITEM\s+CSL_CITATION/gi), zoteroBibliographies: count(instructions, /ADDIN\s+ZOTERO_BIBL/gi), sequenceFigures, sequenceTables },
    revisions, comments: count(comments, /<w:comment\b/gi), footnotes: noteCount(footnotes, 'footnote'), endnotes: noteCount(endnotes, 'endnote'), headers, footers, sections: count(document, /<w:sectPr\b/gi), externalRelationships: count(rels, /\bTargetMode="External"/gi), alternateContent: count(document, /<mc:AlternateContent\b/gi), altChunks: count(document, /<w:altChunk\b/gi),
    descriptions: { described, missing: Math.max(0, drawings - described) }, metadata: { title: elementText(core, 'title'), creator: elementText(core, 'creator'), subject: elementText(core, 'subject') }, warnings,
  };
}
