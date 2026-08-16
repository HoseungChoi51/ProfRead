import { createHash } from 'node:crypto';
import { chmod, copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import { nanoid } from 'nanoid';
import { z } from 'zod';
import { config } from '../config.js';
import { db, now, row } from '../db/index.js';
import { sanitizeDocument, sanitizeStylesheet } from '../ingest/sanitize.js';
import { reattach } from '../anchors/reattach.js';
import { applyDocumentEditOperations } from '../edits/index.js';
import { academicMimeTypes } from './bundle.js';
import { acceptedAcademicRepairPlan } from './repairs.js';

export const stagedResultSchema=z.object({
  entryPath:z.string().min(1),
  bundleDirectory:z.string().min(1),
  derivativeHash:z.string().regex(/^[a-f0-9]{64}$/),
  manifest:z.record(z.string(),z.unknown()),
  assets:z.array(z.object({id:z.string(),sourcePath:z.string(),mimeType:z.string(),storagePath:z.string(),bytes:z.number().int().nonnegative(),sha256:z.string().regex(/^[a-f0-9]{64}$/)})),
});
export type StagedAcademicResult=z.infer<typeof stagedResultSchema>;
export interface PublishResult{documentId:string;versionId:string;deduplicated:boolean}
type Job={id:string;source_kind:string;source_name:string;source_path:string;source_hash:string;target_document_id:string|null;result_json:string|null};

function inside(root:string,path:string):boolean{return resolve(path).startsWith(resolve(root)+sep)}
function validAsset(extension:string,content:Buffer):boolean{
  if(extension==='.css')return !content.subarray(0,512).includes(0);if(content.length<4)return false;
  if(extension==='.png')return content.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
  if(extension==='.jpg'||extension==='.jpeg')return content[0]===0xff&&content[1]===0xd8;
  if(extension==='.gif')return ['GIF87a','GIF89a'].includes(content.subarray(0,6).toString('ascii'));
  if(extension==='.webp')return content.subarray(0,4).toString('ascii')==='RIFF'&&content.subarray(8,12).toString('ascii')==='WEBP';
  if(extension==='.svg')return /<svg[\s>]/i.test(content.subarray(0,4096).toString('utf8').replace(/^\s*<\?xml[^>]*>/,''));
  if(extension==='.woff')return content.subarray(0,4).toString('ascii')==='wOFF';if(extension==='.woff2')return content.subarray(0,4).toString('ascii')==='wOF2';
  if(extension==='.ttf')return content.readUInt32BE(0)===0x00010000;if(extension==='.otf')return content.subarray(0,4).toString('ascii')==='OTTO';return false;
}

export async function publishAcademicImport(jobId:string):Promise<PublishResult>{
  const job=row<Job>('SELECT id,source_kind,source_name,source_path,source_hash,target_document_id,result_json FROM import_jobs WHERE id=?',jobId);if(!job||!job.result_json)throw new Error('Import result is unavailable');
  const staged=stagedResultSchema.parse(JSON.parse(job.result_json)),jobRoot=join(config.dataDir,'imports',jobId);
  if(!inside(jobRoot,staged.bundleDirectory)||!inside(jobRoot,job.source_path))throw new Error('Import staging path is outside its job directory');
  const repairPlan=acceptedAcademicRepairPlan(jobId),repairHash=repairPlan.operations.length?createHash('sha256').update(`academic-repair-v1\0${staged.derivativeHash}\0${repairPlan.signature}`).digest('hex'):staged.derivativeHash,targetScopedHash=job.target_document_id?createHash('sha256').update(`academic-target-v1\0${job.target_document_id}\0${repairHash}`).digest('hex'):repairHash;
  const existing=job.target_document_id
    ? row<{id:string;document_id:string}>('SELECT id,document_id FROM document_versions WHERE document_id=? AND content_hash IN (?,?) ORDER BY version DESC LIMIT 1',job.target_document_id,repairHash,targetScopedHash)
    : row<{id:string;document_id:string}>('SELECT id,document_id FROM document_versions WHERE content_hash=?',repairHash);
  if(existing){const time=now();db.exec('BEGIN IMMEDIATE');try{const updated=db.prepare("UPDATE import_jobs SET status='published',stage='published',document_id=?,document_version_id=?,progress=1,error=NULL,updated_at=?,completed_at=? WHERE id=? AND status='finalizing'").run(existing.document_id,existing.id,time,time,jobId);if(!updated.changes)throw new Error('Import publication state changed');for(const id of repairPlan.findingIds)db.prepare("UPDATE import_findings SET applied_at=?,updated_at=? WHERE id=? AND import_job_id=? AND decision='accepted'").run(time,time,id,jobId);db.exec('COMMIT')}catch(error){db.exec('ROLLBACK');throw error}return{documentId:existing.document_id,versionId:existing.id,deduplicated:true}}
  const contentHash=job.target_document_id?targetScopedHash:repairHash;
  const versionId=nanoid(),documentId=job.target_document_id??nanoid(),directory=join(config.dataDir,'documents',versionId),assetIds=new Map(staged.assets.map(asset=>[asset.sourcePath,nanoid()])),files=new Map<string,Buffer>();
  let transaction=false;
  try{
    const entryFile=resolve(staged.bundleDirectory,staged.entryPath);if(!inside(staged.bundleDirectory,entryFile))throw new Error('Unsafe staged HTML path');files.set(staged.entryPath,await readFile(entryFile));
    for(const asset of staged.assets){if(!inside(staged.bundleDirectory,asset.storagePath))throw new Error('Unsafe staged asset path');const content=await readFile(asset.storagePath),extension=extname(asset.sourcePath).toLowerCase();if(!validAsset(extension,content))throw new Error(`Converted asset is invalid: ${asset.sourcePath}`);files.set(asset.sourcePath,content)}
    for(const asset of staged.assets)if(extname(asset.sourcePath).toLowerCase()==='.css'){const content=files.get(asset.sourcePath)!;files.set(asset.sourcePath,Buffer.from(sanitizeStylesheet(content.toString('utf8'),asset.sourcePath,target=>assetIds.has(target)?`/api/assets/${versionId}/${assetIds.get(target)}`:null)))}
    let parsed=sanitizeDocument(files.get(staged.entryPath)!.toString('utf8'),staged.entryPath,path=>assetIds.has(path)?`/api/assets/${versionId}/${assetIds.get(path)}`:null);
    if(repairPlan.operations.length){const canonicalBefore=parsed.canonicalText,repaired=applyDocumentEditOperations(parsed.html,repairPlan.operations);if(repaired.canonicalText!==canonicalBefore)throw new Error('An accepted presentation repair attempted to change scholarly content');parsed=repaired}
    await mkdir(join(directory,'assets'),{recursive:true});const htmlPath=join(directory,'document.html'),sourceExtension=extname(job.source_name).toLowerCase()||`.${job.source_kind}`,sourcePath=join(directory,`source${sourceExtension.replace(/[^.a-z0-9-]/g,'')||'.bin'}`);
    await copyFile(job.source_path,sourcePath);await chmod(sourcePath,0o444);await writeFile(htmlPath,parsed.html,{flag:'wx',mode:0o444});
    for(const asset of staged.assets){const id=assetIds.get(asset.sourcePath)!;await writeFile(join(directory,'assets',id),files.get(asset.sourcePath)!,{flag:'wx',mode:0o444})}
    await chmod(directory,0o555);await chmod(join(directory,'assets'),0o555);
    const timestamp=now();db.exec('BEGIN IMMEDIATE');transaction=true;
    if(!job.target_document_id)db.prepare('INSERT INTO documents(id,title,created_at)VALUES(?,?,?)').run(documentId,parsed.title,timestamp);
    else if(!row('SELECT id FROM documents WHERE id=?',documentId))throw new Error('Target document not found');
    const version=row<{next:number}>('SELECT COALESCE(MAX(version),0)+1 next FROM document_versions WHERE document_id=?',documentId)?.next??1;
    db.prepare('INSERT INTO document_versions(id,document_id,content_hash,source_name,entry_path,sanitized_html_path,canonical_text,token_estimate,version,created_at)VALUES(?,?,?,?,?,?,?,?,?,?)').run(versionId,documentId,contentHash,job.source_name,staged.entryPath,htmlPath,parsed.canonicalText,Math.ceil(parsed.canonicalText.length/4),version,timestamp);
    const assetInsert=db.prepare('INSERT INTO assets(id,document_version_id,source_path,content_hash,mime_type,storage_path,byte_size)VALUES(?,?,?,?,?,?,?)');
    for(const asset of staged.assets){const id=assetIds.get(asset.sourcePath)!,content=files.get(asset.sourcePath)!;assetInsert.run(id,versionId,asset.sourcePath,createHash('sha256').update(content).digest('hex'),academicMimeTypes[extname(asset.sourcePath).toLowerCase()]!,join(directory,'assets',id),content.length)}
    const blockInsert=db.prepare('INSERT INTO blocks(id,document_version_id,ordinal,block_type,text_content,visual_data,start_offset,end_offset)VALUES(?,?,?,?,?,?,?,?)');for(const block of parsed.blocks)blockInsert.run(block.id,versionId,block.ordinal,block.type,block.text,block.visual??null,block.start,block.end);
    if(job.target_document_id){const previous=row<{id:string}>('SELECT id FROM document_versions WHERE document_id=? AND id<>? ORDER BY version DESC LIMIT 1',documentId,versionId);if(previous){const anchors=db.prepare('SELECT * FROM anchors WHERE document_version_id=?').all(previous.id) as any[];for(const anchor of anchors){const match=reattach({exact:anchor.exact_quote,prefix:anchor.prefix_text,suffix:anchor.suffix_text,startOffset:anchor.start_offset,blockId:anchor.block_id},parsed.blocks.map(block=>({blockId:block.id,text:block.text,start:block.start,end:block.end}))),matched=parsed.blocks.find(block=>block.id===match.blockId),start=(matched?.start??0)+match.startOffset,end=(matched?.start??0)+match.endOffset,id=nanoid();db.prepare('INSERT INTO anchors(id,document_version_id,block_id,exact_quote,prefix_text,suffix_text,start_offset,end_offset,block_type,status,migrated_from_id,created_at)VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(id,versionId,match.blockId,anchor.exact_quote,anchor.prefix_text,anchor.suffix_text,start,end,anchor.block_type,match.status,anchor.id,timestamp);db.prepare('UPDATE threads SET anchor_id=? WHERE anchor_id=?').run(id,anchor.id);const highlights=db.prepare('SELECT * FROM highlights WHERE anchor_id=?').all(anchor.id) as any[];for(const highlight of highlights)db.prepare('INSERT INTO highlights(id,anchor_id,checked,color,note,kind,created_at,updated_at)VALUES(?,?,?,?,?,?,?,?)').run(nanoid(),id,highlight.checked,highlight.color,highlight.note,highlight.kind,highlight.created_at,timestamp)}}}
    db.prepare('INSERT INTO search_index(kind,entity_id,document_id,title,body,tags,model_id,created_at)VALUES(?,?,?,?,?,?,?,?)').run('article',versionId,documentId,parsed.title,parsed.canonicalText,'','',timestamp);
    const updated=db.prepare("UPDATE import_jobs SET status='published',stage='published',document_id=?,document_version_id=?,progress=1,error=NULL,updated_at=?,completed_at=? WHERE id=? AND status='finalizing'").run(documentId,versionId,timestamp,timestamp,jobId);if(!updated.changes)throw new Error('Import publication state changed');
    for(const id of repairPlan.findingIds)db.prepare("UPDATE import_findings SET applied_at=?,updated_at=? WHERE id=? AND import_job_id=? AND decision='accepted'").run(timestamp,timestamp,id,jobId);
    db.exec('COMMIT');transaction=false;return{documentId,versionId,deduplicated:false};
  }catch(error){if(transaction)db.exec('ROLLBACK');await chmod(directory,0o755).catch(()=>{});await chmod(join(directory,'assets'),0o755).catch(()=>{});await rm(directory,{recursive:true,force:true}).catch(()=>{});throw error}
}
