import { createHash } from 'node:crypto';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { dirname, extname, join } from 'node:path';
import { nanoid } from 'nanoid';
import { config } from '../config.js';
import { db, now, row } from '../db/index.js';
import { sanitizeDocument, sanitizeStylesheet } from './sanitize.js';
import { readSafeZip } from './zip.js';
import { reattach } from '../anchors/reattach.js';

const mimeTypes: Record<string, string> = { '.css':'text/css', '.png':'image/png', '.jpg':'image/jpeg', '.jpeg':'image/jpeg', '.gif':'image/gif', '.webp':'image/webp', '.svg':'image/svg+xml', '.woff':'font/woff', '.woff2':'font/woff2', '.ttf':'font/ttf', '.otf':'font/otf' };
function validAsset(extension:string,content:Buffer):boolean{if(extension==='.css')return !content.subarray(0,512).includes(0);if(content.length<4)return false;if(extension==='.png')return content.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]));if(extension==='.jpg'||extension==='.jpeg')return content[0]===0xff&&content[1]===0xd8;if(extension==='.gif')return content.subarray(0,6).toString('ascii')==='GIF87a'||content.subarray(0,6).toString('ascii')==='GIF89a';if(extension==='.webp')return content.subarray(0,4).toString('ascii')==='RIFF'&&content.subarray(8,12).toString('ascii')==='WEBP';if(extension==='.svg')return /<svg[\s>]/i.test(content.subarray(0,4096).toString('utf8').replace(/^\s*<\?xml[^>]*>/,''));if(extension==='.woff')return content.subarray(0,4).toString('ascii')==='wOFF';if(extension==='.woff2')return content.subarray(0,4).toString('ascii')==='wOF2';if(extension==='.ttf')return content.readUInt32BE(0)===0x00010000;if(extension==='.otf')return content.subarray(0,4).toString('ascii')==='OTTO';return false}
export interface ImportResult { documentId?: string; versionId?: string; deduplicated?: boolean; entryChoices?: string[] }

export async function importSource(input: { buffer: Buffer; filename: string; mimeType: string; entryPath?: string; documentId?: string }): Promise<ImportResult> {
  const isZip = input.mimeType === 'application/zip' || /\.zip$/i.test(input.filename);
  const limit = isZip ? config.limits.zipBytes : config.limits.htmlBytes;
  if (input.buffer.length > limit) throw new Error(`Upload exceeds ${limit} byte limit`);
  if (!isZip && !/\.html?$/i.test(input.filename) && input.mimeType !== 'text/html') throw new Error('Only HTML files and ZIP bundles are supported');
  const sourceHash = createHash('sha256').update(input.buffer).digest('hex');
  const existing = row<{ id: string; document_id: string }>('SELECT id, document_id FROM document_versions WHERE content_hash = ?', sourceHash);
  if (existing) return { documentId: existing.document_id, versionId: existing.id, deduplicated: true };

  let files = new Map<string, Buffer>(); let entryPath = input.filename;
  if (isZip) {
    const archive = await readSafeZip(input.buffer);
    if (!archive.htmlEntries.length) throw new Error('ZIP does not contain an HTML entry');
    if (!input.entryPath && archive.htmlEntries.length > 1) return { entryChoices: archive.htmlEntries.sort() };
    entryPath = input.entryPath ?? archive.htmlEntries[0]!;
    if (!archive.htmlEntries.includes(entryPath)) throw new Error('Selected entry is not an HTML file in this ZIP');
    files = archive.files;
  } else files.set(entryPath, input.buffer);

  const versionId = nanoid(); const documentId = input.documentId ?? nanoid(); const directory = join(config.dataDir, 'documents', versionId);
  const assetIds = new Map<string, string>();
  for (const path of files.keys()) if (path !== entryPath && mimeTypes[extname(path).toLowerCase()]) {const extension=extname(path).toLowerCase();if(!validAsset(extension,files.get(path)!))throw new Error(`Asset content does not match its declared type: ${path}`);assetIds.set(path, nanoid());}
  for(const [path] of assetIds)if(extname(path).toLowerCase()==='.css')files.set(path,Buffer.from(sanitizeStylesheet(files.get(path)!.toString('utf8'),path,target=>assetIds.has(target)?`/api/assets/${versionId}/${assetIds.get(target)}`:null)));
  const parsed = sanitizeDocument(files.get(entryPath)!.toString('utf8'), entryPath, path => assetIds.has(path) ? `/api/assets/${versionId}/${assetIds.get(path)}` : null);
  await mkdir(join(directory, 'assets'), { recursive: true });
  const htmlPath = join(directory, 'document.html'); const sourcePath = join(directory, `source${isZip ? '.zip' : '.html'}`);
  await writeFile(sourcePath, input.buffer, { flag: 'wx', mode: 0o444 }); await writeFile(htmlPath, parsed.html, { flag: 'wx', mode: 0o444 });
  for (const [path, id] of assetIds) { const target = join(directory, 'assets', id); await mkdir(dirname(target), { recursive: true }); await writeFile(target, files.get(path)!, { flag: 'wx', mode: 0o444 }); }
  await chmod(directory, 0o555); await chmod(join(directory, 'assets'), 0o555);

  const timestamp = now();
  const transaction = () => {
    db.exec('BEGIN IMMEDIATE');
    try {
    if (!input.documentId) db.prepare('INSERT INTO documents (id,title,created_at) VALUES (?,?,?)').run(documentId, parsed.title, timestamp);
    else if (!row('SELECT id FROM documents WHERE id=?', documentId)) throw new Error('Target document not found');
    const version = (row<{ next: number }>('SELECT COALESCE(MAX(version),0)+1 AS next FROM document_versions WHERE document_id=?', documentId)?.next ?? 1);
    db.prepare(`INSERT INTO document_versions (id,document_id,content_hash,source_name,entry_path,sanitized_html_path,canonical_text,token_estimate,version,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run(versionId, documentId, sourceHash, input.filename, entryPath, htmlPath, parsed.canonicalText, Math.ceil(parsed.canonicalText.length / 4), version, timestamp);
    const assetInsert = db.prepare('INSERT INTO assets (id,document_version_id,source_path,content_hash,mime_type,storage_path,byte_size) VALUES (?,?,?,?,?,?,?)');
    for (const [path, id] of assetIds) { const content = files.get(path)!; assetInsert.run(id, versionId, path, createHash('sha256').update(content).digest('hex'), mimeTypes[extname(path).toLowerCase()]!, join(directory,'assets',id), content.length); }
    const blockInsert = db.prepare('INSERT INTO blocks (id,document_version_id,ordinal,block_type,text_content,visual_data,start_offset,end_offset) VALUES (?,?,?,?,?,?,?,?)');
    for (const block of parsed.blocks) blockInsert.run(block.id, versionId, block.ordinal, block.type, block.text, block.visual??null, block.start, block.end);
    if (input.documentId) {
      const previous=row<{id:string}>('SELECT id FROM document_versions WHERE document_id=? AND id<>? ORDER BY version DESC LIMIT 1',documentId,versionId);
      if(previous){const anchors=db.prepare('SELECT * FROM anchors WHERE document_version_id=?').all(previous.id) as any[];for(const anchor of anchors){const match=reattach({exact:anchor.exact_quote,prefix:anchor.prefix_text,suffix:anchor.suffix_text,startOffset:anchor.start_offset,blockId:anchor.block_id},parsed.blocks.map(b=>({blockId:b.id,text:b.text,start:b.start,end:b.end}))),matchedBlock=parsed.blocks.find(block=>block.id===match.blockId),globalStart=(matchedBlock?.start??0)+match.startOffset,globalEnd=(matchedBlock?.start??0)+match.endOffset,newId=nanoid();db.prepare(`INSERT INTO anchors(id,document_version_id,block_id,exact_quote,prefix_text,suffix_text,start_offset,end_offset,block_type,status,migrated_from_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(newId,versionId,match.blockId,anchor.exact_quote,anchor.prefix_text,anchor.suffix_text,globalStart,globalEnd,anchor.block_type,match.status,anchor.id,timestamp);db.prepare('UPDATE threads SET anchor_id=? WHERE anchor_id=?').run(newId,anchor.id);const highlights=db.prepare('SELECT * FROM highlights WHERE anchor_id=?').all(anchor.id) as any[];for(const highlight of highlights)db.prepare('INSERT INTO highlights(id,anchor_id,checked,color,note,kind,created_at,updated_at)VALUES(?,?,?,?,?,?,?,?)').run(nanoid(),newId,highlight.checked,highlight.color,highlight.note,highlight.kind,highlight.created_at,timestamp);}}
    }
    db.prepare('INSERT INTO search_index (kind,entity_id,document_id,title,body,tags,model_id,created_at) VALUES (?,?,?,?,?,?,?,?)').run('article', versionId, documentId, parsed.title, parsed.canonicalText, '', '', timestamp);
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  };
  transaction();
  return { documentId, versionId, deduplicated: false };
}
