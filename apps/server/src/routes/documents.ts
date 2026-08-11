import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { z } from 'zod';
import { anchorSelectorSchema } from '@afterdraft/shared';
import { db, now, row, rows } from '../db/index.js';
import { importSource } from '../ingest/index.js';
import { ensureContexts } from '../models/context-jobs.js';
import { config } from '../config.js';
import {effectiveVersion,readEffectiveHtml}from'../edits/effective.js';
import{BRIDGE,READER_CSS}from'../ingest/sanitize.js';

const responsiveReaderStyle='<style id="afterdraft-responsive">html{overflow-x:hidden}body{box-sizing:border-box!important;width:min(calc(100% - clamp(2rem,6vw,6rem)),1200px)!important;max-width:none!important;margin:clamp(1.5rem,4vw,3rem) auto!important;padding:0!important}body *{box-sizing:border-box}pre,table{max-width:100%;overflow:auto}</style>';

export function registerDocumentRoutes(app: FastifyInstance): void {
  app.get('/api/documents', async () => rows(`SELECT d.*, v.id version_id, v.version, v.token_estimate,
    (SELECT COUNT(*) FROM highlights h JOIN anchors a ON a.id=h.anchor_id JOIN document_versions dv ON dv.id=a.document_version_id WHERE dv.document_id=d.id AND dv.version=(SELECT MAX(latest.version) FROM document_versions latest WHERE latest.document_id=d.id) AND h.checked=1) checked_count,
    rp.offset_ratio FROM documents d JOIN document_versions v ON v.document_id=d.id AND v.version=(SELECT MAX(version) FROM document_versions WHERE document_id=d.id)
    LEFT JOIN reading_progress rp ON rp.document_id=d.id ORDER BY COALESCE(d.last_opened_at,d.created_at) DESC`));
  app.post('/api/imports', async (request, reply) => {
    const upload = await request.file({ limits: { fileSize: 100 * 1024 * 1024, files: 1 } });
    if (!upload) return reply.code(400).send({ error: 'Upload is required' });
    const buffer = await upload.toBuffer(); const query = request.query as { entryPath?: string; documentId?: string };
    try { const result = await importSource({ buffer, filename: upload.filename, mimeType: upload.mimetype, ...(query.entryPath ? { entryPath: query.entryPath } : {}), ...(query.documentId ? { documentId: query.documentId } : {}) }); return reply.code(result.entryChoices ? 300 : 201).send(result); }
    catch (error) { request.log.warn(error); return reply.code(400).send({ error: error instanceof Error ? error.message : 'Import failed' }); }
  });
  app.get('/api/documents/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const document = row(`SELECT d.*,v.id version_id,v.version,v.entry_path,v.token_estimate,v.created_at version_created_at,rp.block_id,rp.offset_ratio,rp.last_thread_id
      FROM documents d JOIN document_versions v ON v.document_id=d.id AND v.version=(SELECT MAX(version) FROM document_versions WHERE document_id=d.id)
      LEFT JOIN reading_progress rp ON rp.document_id=d.id WHERE d.id=?`, id);
    if (!document) return reply.code(404).send({ error: 'Document not found' });
    db.prepare('UPDATE documents SET last_opened_at=? WHERE id=?').run(now(), id); ensureContexts((document as {version_id:string}).version_id); return document;
  });
  app.get('/api/documents/:id/versions', async request => rows('SELECT id,version,source_name,entry_path,token_estimate,created_at FROM document_versions WHERE document_id=? ORDER BY version DESC', (request.params as { id:string }).id));
  app.get('/api/documents/:id/tags',async request=>rows<{tag:string}>('SELECT tag FROM document_tags WHERE document_id=? ORDER BY tag',(request.params as {id:string}).id).map(item=>item.tag));
  app.put('/api/documents/:id/tags',async(request,reply)=>{const parsed=z.object({tags:z.array(z.string().trim().min(1).max(40)).max(30)}).safeParse(request.body);if(!parsed.success)return reply.code(400).send({error:parsed.error.flatten()});const id=(request.params as {id:string}).id;db.exec('BEGIN IMMEDIATE');try{db.prepare('DELETE FROM document_tags WHERE document_id=?').run(id);const insert=db.prepare('INSERT INTO document_tags(document_id,tag)VALUES(?,?)');for(const tag of new Set(parsed.data.tags))insert.run(id,tag);db.prepare('UPDATE search_index SET tags=? WHERE document_id=?').run(parsed.data.tags.join(' '),id);db.exec('COMMIT');return{ok:true}}catch(error){db.exec('ROLLBACK');throw error}});
  app.get('/api/versions/:id/content', async (request, reply) => {
    const version = effectiveVersion((request.params as { id:string }).id);
    if (!version) return reply.code(404).send('Not found');
    const nonce = randomBytes(18).toString('base64url'); const source=await readEffectiveHtml(version.id),html=source.replace(/<script[^>]*nonce="__AFTERDRAFT_NONCE__"[^>]*>[^]*?<\/script>/gi,'').replace('</head>',`${responsiveReaderStyle}<style id="afterdraft-current">${READER_CSS}</style></head>`).replace('</body>',`<script nonce="${nonce}">${BRIDGE}</script></body>`);
    return reply.header('content-type','text/html; charset=utf-8').header('cache-control','private, no-store')
      .header('referrer-policy','strict-origin-when-cross-origin')
      .header('content-security-policy', `sandbox allow-scripts allow-same-origin allow-presentation; default-src 'none'; img-src 'self' data: blob:; font-src 'self'; style-src 'unsafe-inline' 'self'; script-src 'nonce-${nonce}'; frame-src https://www.youtube.com https://www.youtube-nocookie.com; connect-src 'none'; form-action 'none'; base-uri 'none'`).send(html);
  });
  app.get('/api/assets/:versionId/:assetId', async (request, reply) => {
    const { versionId, assetId } = request.params as { versionId:string; assetId:string };
    const asset = row<{ storage_path:string; mime_type:string; content_hash:string }>('SELECT storage_path,mime_type,content_hash FROM assets WHERE id=? AND document_version_id=?', assetId, versionId);
    if (!asset) return reply.code(404).send({ error: 'Asset not found' });
    return reply.header('content-type', asset.mime_type).header('x-content-type-options','nosniff').header('cache-control','private, max-age=31536000, immutable').header('etag',`"${asset.content_hash}"`).send(await readFile(asset.storage_path));
  });
  app.get('/api/generated/:imageId.png',async(request,reply)=>{const imageId=(request.params as {imageId:string}).imageId;if(!/^[A-Za-z0-9_-]+$/.test(imageId))return reply.code(400).send({error:'Invalid image ID'});try{return reply.header('content-type','image/png').header('cache-control','private, max-age=31536000, immutable').send(await readFile(join(config.dataDir,'generated',`${imageId}.png`)))}catch{return reply.code(404).send({error:'Generated image not found'})}});
  app.get('/api/documents/:id/blocks', async request => rows('SELECT b.* FROM blocks b JOIN document_versions v ON v.id=b.document_version_id WHERE v.document_id=? AND v.version=(SELECT MAX(version) FROM document_versions WHERE document_id=?) ORDER BY ordinal', (request.params as {id:string}).id, (request.params as {id:string}).id));
  app.get('/api/documents/:id/highlights',async request=>rows(`SELECT h.id,h.checked,h.color,h.kind,h.note,a.id anchor_id,a.block_id,a.exact_quote,a.start_offset-b.start_offset local_start_offset,a.end_offset-b.start_offset local_end_offset FROM highlights h JOIN anchors a ON a.id=h.anchor_id LEFT JOIN blocks b ON b.document_version_id=a.document_version_id AND b.id=a.block_id JOIN document_versions v ON v.id=a.document_version_id WHERE v.document_id=? AND v.version=(SELECT MAX(version) FROM document_versions WHERE document_id=?)`,(request.params as {id:string}).id,(request.params as {id:string}).id));
  app.get('/api/versions/:id/jobs',async request=>rows('SELECT id,kind,status,progress,error,updated_at FROM background_jobs WHERE document_version_id=? ORDER BY created_at DESC',(request.params as {id:string}).id));

  app.post('/api/anchors', async (request, reply) => {
    const parsed = z.object({ documentVersionId:z.string(), selector:anchorSelectorSchema }).safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const s=parsed.data.selector; const block=row<{ id:string; text_content:string;start_offset:number }>('SELECT id,text_content,start_offset FROM blocks WHERE id=? AND document_version_id=?',s.blockId,parsed.data.documentVersionId);
    if (!block) return reply.code(409).send({ error:'Anchor no longer matches this document version' });
    let localStart=0;
    if(s.blockType==='text'){
      const exactAtOffset=s.endOffset>=s.startOffset&&block.text_content.slice(s.startOffset,s.endOffset)===s.exact;
      if(exactAtOffset)localStart=s.startOffset;
      else{
        const candidates:number[]=[];let cursor=block.text_content.indexOf(s.exact);
        while(cursor>=0){candidates.push(cursor);cursor=block.text_content.indexOf(s.exact,cursor+Math.max(1,s.exact.length))}
        if(!candidates.length)return reply.code(409).send({error:'Anchor no longer matches this document version'});
        const score=(offset:number)=>(s.prefix&&block.text_content.slice(Math.max(0,offset-s.prefix.length),offset)===s.prefix?2:0)+(s.suffix&&block.text_content.slice(offset+s.exact.length,offset+s.exact.length+s.suffix.length)===s.suffix?2:0)-Math.abs(offset-s.startOffset)/Math.max(1,block.text_content.length);
        localStart=candidates.sort((a,b)=>score(b)-score(a))[0]!;
      }
    }
    const globalStart=block.start_offset+localStart,globalEnd=globalStart+s.exact.length;const id=nanoid(); db.prepare(`INSERT INTO anchors (id,document_version_id,block_id,exact_quote,prefix_text,suffix_text,start_offset,end_offset,block_type,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`).run(id,parsed.data.documentVersionId,s.blockId,s.exact,s.prefix,s.suffix,globalStart,globalEnd,s.blockType,now()); return reply.code(201).send({id,...s,startOffset:globalStart,endOffset:globalEnd,status:'attached'});
  });
  app.post('/api/highlights', async (request, reply) => {
    const parsed=z.object({anchorId:z.string(),kind:z.enum(['important','question','comment']).optional(),note:z.string().max(2000).nullable().optional(),color:z.enum(['yellow','green','blue','pink']).optional(),checked:z.boolean().optional()}).safeParse(request.body);
    if(!parsed.success)return reply.code(400).send({error:parsed.error.flatten()});
    if(!row('SELECT id FROM anchors WHERE id=?',parsed.data.anchorId))return reply.code(404).send({error:'Anchor not found'});
    const legacyKind=parsed.data.color==='blue'?'question':parsed.data.color==='pink'?'comment':'important',kind=parsed.data.kind??legacyKind,note=parsed.data.note?.trim()||null;
    if(kind==='comment'&&!note)return reply.code(400).send({error:'Comment highlights require a non-empty note'});
    const color=kind==='important'?'yellow':kind==='question'?'blue':'pink',checked=kind!=='question',id=nanoid(),time=now();
    db.prepare('INSERT INTO highlights (id,anchor_id,checked,color,kind,note,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)').run(id,parsed.data.anchorId,checked?1:0,color,kind,note,time,time); return reply.code(201).send({id,anchorId:parsed.data.anchorId,kind,note,color,checked,createdAt:time});
  });
  app.patch('/api/highlights/:id', async (request,reply)=>{const parsed=z.object({kind:z.enum(['important','question','comment']).optional(),note:z.string().max(2000).nullable().optional(),color:z.enum(['yellow','green','blue','pink']).optional(),checked:z.boolean().optional()}).refine(value=>Object.keys(value).length>0,'At least one field is required').safeParse(request.body);if(!parsed.success)return reply.code(400).send({error:parsed.error.flatten()});const id=(request.params as {id:string}).id,current=row<{kind:string;color:string;note:string|null}>('SELECT kind,color,note FROM highlights WHERE id=?',id);if(!current)return reply.code(404).send({error:'Highlight not found'});const legacyKind=parsed.data.color==='blue'?'question':parsed.data.color==='pink'?'comment':'important',kind=parsed.data.kind??(parsed.data.color?legacyKind:current.kind),note=parsed.data.note===undefined?current.note:parsed.data.note?.trim()||null;if(kind==='comment'&&!note)return reply.code(400).send({error:'Comment highlights require a non-empty note'});const color=kind==='important'?'yellow':kind==='question'?'blue':'pink',checked=kind!=='question';db.prepare('UPDATE highlights SET checked=?,note=?,color=?,kind=?,updated_at=? WHERE id=?').run(checked?1:0,note,color,kind,now(),id);return {ok:true,kind,note,color,checked};});
  app.delete('/api/highlights/:id',async(request,reply)=>{const result=db.prepare('DELETE FROM highlights WHERE id=?').run((request.params as {id:string}).id);return result.changes?{ok:true}:reply.code(404).send({error:'Highlight not found'});});
  app.put('/api/documents/:id/progress', async (request,reply)=>{const parsed=z.object({blockId:z.string().nullable(),offsetRatio:z.number().min(0).max(1),lastThreadId:z.string().nullable().optional()}).safeParse(request.body);if(!parsed.success)return reply.code(400).send({error:parsed.error.flatten()});db.prepare(`INSERT INTO reading_progress (document_id,block_id,offset_ratio,last_thread_id,updated_at) VALUES (?,?,?,?,?) ON CONFLICT(document_id) DO UPDATE SET block_id=excluded.block_id,offset_ratio=excluded.offset_ratio,last_thread_id=COALESCE(excluded.last_thread_id,reading_progress.last_thread_id),updated_at=excluded.updated_at`).run((request.params as {id:string}).id,parsed.data.blockId,parsed.data.offsetRatio,parsed.data.lastThreadId??null,now());return {ok:true};});
}
