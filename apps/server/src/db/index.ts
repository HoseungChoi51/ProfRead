import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../config.js';
import { schema } from './schema.js';
import { reattach } from '../anchors/reattach.js';

mkdirSync(config.dataDir, { recursive: true });
mkdirSync(join(config.dataDir, 'documents'), { recursive: true });
mkdirSync(join(config.dataDir, 'exports'), { recursive: true });
mkdirSync(join(config.dataDir, 'generated'), { recursive: true });
mkdirSync(join(config.dataDir, 'edits'), { recursive: true });
export const db = new DatabaseSync(join(config.dataDir, 'afterdraft.sqlite'));
db.exec(schema);
let blockColumns=db.prepare('PRAGMA table_info(blocks)').all() as Array<{name:string;pk:number}>;
if(!blockColumns.some(column=>column.name==='visual_data')){db.exec('ALTER TABLE blocks ADD COLUMN visual_data TEXT');blockColumns=db.prepare('PRAGMA table_info(blocks)').all() as Array<{name:string;pk:number}>}
if(blockColumns.find(column=>column.name==='id')?.pk===1&&blockColumns.find(column=>column.name==='document_version_id')?.pk===0){db.exec(`BEGIN IMMEDIATE;ALTER TABLE blocks RENAME TO blocks_legacy;CREATE TABLE blocks(id TEXT NOT NULL,document_version_id TEXT NOT NULL REFERENCES document_versions(id) ON DELETE CASCADE,ordinal INTEGER NOT NULL,block_type TEXT NOT NULL,text_content TEXT NOT NULL,visual_data TEXT,start_offset INTEGER NOT NULL,end_offset INTEGER NOT NULL,PRIMARY KEY(document_version_id,id),UNIQUE(document_version_id,ordinal));INSERT INTO blocks(id,document_version_id,ordinal,block_type,text_content,visual_data,start_offset,end_offset)SELECT id,document_version_id,ordinal,block_type,text_content,visual_data,start_offset,end_offset FROM blocks_legacy;DROP TABLE blocks_legacy;COMMIT;`);blockColumns=db.prepare('PRAGMA table_info(blocks)').all() as Array<{name:string;pk:number}>}
const sessionColumns=db.prepare('PRAGMA table_info(sessions)').all() as Array<{name:string}>;
if(!sessionColumns.some(column=>column.name==='csrf_hash'))db.exec("ALTER TABLE sessions ADD COLUMN csrf_hash TEXT NOT NULL DEFAULT ''");
const documentColumns=db.prepare('PRAGMA table_info(documents)').all() as Array<{name:string}>;
if(!documentColumns.some(column=>column.name==='group_id'))db.exec('ALTER TABLE documents ADD COLUMN group_id TEXT REFERENCES article_groups(id) ON DELETE SET NULL');
db.exec('CREATE INDEX IF NOT EXISTS documents_group_id_idx ON documents(group_id)');
const runColumns=db.prepare('PRAGMA table_info(model_runs)').all() as Array<{name:string}>;
if(!runColumns.some(column=>column.name==='provider_response_id'))db.exec('ALTER TABLE model_runs ADD COLUMN provider_response_id TEXT');
if(!runColumns.some(column=>column.name==='response_text'))db.exec('ALTER TABLE model_runs ADD COLUMN response_text TEXT');
db.prepare('INSERT OR IGNORE INTO migrations(version,applied_at)VALUES(1,?)').run(new Date().toISOString());
db.prepare('INSERT OR IGNORE INTO migrations(version,applied_at)VALUES(2,?)').run(new Date().toISOString());
db.prepare('INSERT OR IGNORE INTO migrations(version,applied_at)VALUES(3,?)').run(new Date().toISOString());
db.prepare('INSERT OR IGNORE INTO migrations(version,applied_at)VALUES(4,?)').run(new Date().toISOString());
db.prepare('INSERT OR IGNORE INTO migrations(version,applied_at)VALUES(5,?)').run(new Date().toISOString());
db.prepare('INSERT OR IGNORE INTO migrations(version,applied_at)VALUES(6,?)').run(new Date().toISOString());
db.prepare('INSERT OR IGNORE INTO migrations(version,applied_at)VALUES(7,?)').run(new Date().toISOString());
db.prepare('INSERT OR IGNORE INTO migrations(version,applied_at)VALUES(8,?)').run(new Date().toISOString());
db.prepare('INSERT OR IGNORE INTO migrations(version,applied_at)VALUES(9,?)').run(new Date().toISOString());
db.prepare('INSERT OR IGNORE INTO migrations(version,applied_at)VALUES(10,?)').run(new Date().toISOString());

const migration11Applied=db.prepare('SELECT 1 FROM migrations WHERE version=11').get();
if(!migration11Applied){
  db.exec('BEGIN IMMEDIATE');
  try{
    const highlightColumns=db.prepare('PRAGMA table_info(highlights)').all() as Array<{name:string}>;
    if(!highlightColumns.some(column=>column.name==='kind'))db.exec('ALTER TABLE highlights ADD COLUMN kind TEXT');
    const threadColumns=db.prepare('PRAGMA table_info(threads)').all() as Array<{name:string}>;
    if(!threadColumns.some(column=>column.name==='annotation_text'))db.exec('ALTER TABLE threads ADD COLUMN annotation_text TEXT');
    const artifactColumns=db.prepare('PRAGMA table_info(artifacts)').all() as Array<{name:string}>;
    if(!artifactColumns.some(column=>column.name==='basis_document_version_id'))db.exec('ALTER TABLE artifacts ADD COLUMN basis_document_version_id TEXT');
    if(!artifactColumns.some(column=>column.name==='basis_revision'))db.exec('ALTER TABLE artifacts ADD COLUMN basis_revision INTEGER');
    if(!artifactColumns.some(column=>column.name==='basis_signal_hash'))db.exec('ALTER TABLE artifacts ADD COLUMN basis_signal_hash TEXT');
    db.exec(`UPDATE highlights SET kind=CASE lower(color) WHEN 'blue' THEN 'question' WHEN 'pink' THEN 'comment' ELSE 'important' END WHERE kind IS NULL OR kind NOT IN ('important','question','comment')`);
    type LegacyAnchor={id:string;document_version_id:string;block_id:string;exact_quote:string;prefix_text:string;suffix_text:string;start_offset:number;end_offset:number;status:string};
    type LegacyBlock={id:string;document_version_id:string;text_content:string;start_offset:number;end_offset:number;ordinal:number};
    const legacyAnchors=db.prepare('SELECT id,document_version_id,block_id,exact_quote,prefix_text,suffix_text,start_offset,end_offset,status FROM anchors').all() as LegacyAnchor[];
    const blocksByVersion=new Map<string,LegacyBlock[]>(),selectBlocks=db.prepare('SELECT id,document_version_id,text_content,start_offset,end_offset,ordinal FROM blocks WHERE document_version_id=? ORDER BY ordinal'),updateAnchor=db.prepare('UPDATE anchors SET block_id=?,start_offset=?,end_offset=?,status=? WHERE id=?');
    const anchorMatchScore=(anchor:LegacyAnchor,block:LegacyBlock,localStart:number):number=>{
      if(localStart<0||localStart+anchor.exact_quote.length>block.text_content.length||block.text_content.slice(localStart,localStart+anchor.exact_quote.length)!==anchor.exact_quote)return -1;
      const before=block.text_content.slice(Math.max(0,localStart-anchor.prefix_text.length),localStart),after=block.text_content.slice(localStart+anchor.exact_quote.length,localStart+anchor.exact_quote.length+anchor.suffix_text.length);
      return Number(!anchor.prefix_text||before===anchor.prefix_text)+Number(!anchor.suffix_text||after===anchor.suffix_text);
    };
    for(const anchor of legacyAnchors){
      let blocks=blocksByVersion.get(anchor.document_version_id);if(!blocks){blocks=selectBlocks.all(anchor.document_version_id) as LegacyBlock[];blocksByVersion.set(anchor.document_version_id,blocks)}
      const currentBlock=blocks.find(block=>block.id===anchor.block_id),globalLocal=currentBlock?anchor.start_offset-currentBlock.start_offset:-1,globalScore=currentBlock?anchorMatchScore(anchor,currentBlock,globalLocal):-1,legacyLocal=anchor.start_offset,legacyScore=currentBlock?anchorMatchScore(anchor,currentBlock,legacyLocal):-1;
      if(currentBlock&&globalScore>=0&&globalScore>=legacyScore){const globalEnd=anchor.start_offset+anchor.exact_quote.length;if(anchor.end_offset!==globalEnd||anchor.status!=='attached')updateAnchor.run(currentBlock.id,anchor.start_offset,globalEnd,'attached',anchor.id);continue}
      if(currentBlock&&legacyScore>=0){const globalStart=currentBlock.start_offset+legacyLocal;updateAnchor.run(currentBlock.id,globalStart,globalStart+anchor.exact_quote.length,'attached',anchor.id);continue}
      const match=reattach({exact:anchor.exact_quote,prefix:anchor.prefix_text,suffix:anchor.suffix_text,startOffset:anchor.start_offset,blockId:anchor.block_id},blocks.map(block=>({blockId:block.id,text:block.text_content,start:block.start_offset,end:block.end_offset}))),matchedBlock=blocks.find(block=>block.id===match.blockId);
      if(!matchedBlock){db.prepare("UPDATE anchors SET status='unmatched' WHERE id=?").run(anchor.id);continue}
      const exactMatch=match.status==='attached'&&anchorMatchScore(anchor,matchedBlock,match.startOffset)>=0,globalStart=matchedBlock.start_offset+match.startOffset,globalEnd=globalStart+(exactMatch?anchor.exact_quote.length:Math.max(0,match.endOffset-match.startOffset));
      updateAnchor.run(matchedBlock.id,globalStart,globalEnd,exactMatch?'attached':'unmatched',anchor.id);
    }
    db.prepare('INSERT INTO migrations(version,applied_at)VALUES(11,?)').run(new Date().toISOString());
    db.exec('COMMIT');
  }catch(error){db.exec('ROLLBACK');throw error}
}

export function now(): string { return new Date().toISOString(); }
export function rows<T>(sql: string, ...params: any[]): T[] { return db.prepare(sql).all(...params) as T[]; }
export function row<T>(sql: string, ...params: any[]): T | undefined { return db.prepare(sql).get(...params) as T | undefined; }
