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

const migration12Applied=db.prepare('SELECT 1 FROM migrations WHERE version=12').get();
if(!migration12Applied){
  db.exec('BEGIN IMMEDIATE');
  try{
    const threadColumns=db.prepare('PRAGMA table_info(threads)').all() as Array<{name:string}>;
    if(!threadColumns.some(column=>column.name==='kind'))db.exec("ALTER TABLE threads ADD COLUMN kind TEXT NOT NULL DEFAULT 'discussion'");
    if(!threadColumns.some(column=>column.name==='annotation_candidate_text'))db.exec('ALTER TABLE threads ADD COLUMN annotation_candidate_text TEXT');
    if(!threadColumns.some(column=>column.name==='annotation_candidate_source_message_id'))db.exec('ALTER TABLE threads ADD COLUMN annotation_candidate_source_message_id TEXT REFERENCES messages(id) ON DELETE SET NULL');
    if(!threadColumns.some(column=>column.name==='annotation_candidate_status'))db.exec('ALTER TABLE threads ADD COLUMN annotation_candidate_status TEXT');
    if(!threadColumns.some(column=>column.name==='annotation_candidate_created_at'))db.exec('ALTER TABLE threads ADD COLUMN annotation_candidate_created_at TEXT');
    const revisionColumns=db.prepare('PRAGMA table_info(document_edit_revisions)').all() as Array<{name:string}>;
    if(!revisionColumns.some(column=>column.name==='origin_type'))db.exec("ALTER TABLE document_edit_revisions ADD COLUMN origin_type TEXT NOT NULL DEFAULT 'manual'");
    if(!revisionColumns.some(column=>column.name==='origin_id'))db.exec('ALTER TABLE document_edit_revisions ADD COLUMN origin_id TEXT');
    db.exec(`CREATE TABLE IF NOT EXISTS writer_sources(
      id TEXT PRIMARY KEY,thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
      source_type TEXT NOT NULL CHECK(source_type IN ('message','thread-annotation','artifact','highlight')),source_id TEXT NOT NULL,
      label TEXT NOT NULL,anchor_id TEXT,snapshot_json TEXT NOT NULL,snapshot_hash TEXT NOT NULL,created_at TEXT NOT NULL,
      UNIQUE(thread_id,source_type,source_id));
      CREATE TABLE IF NOT EXISTS writer_proposals(
      id TEXT PRIMARY KEY,thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
      model_run_id TEXT NOT NULL UNIQUE REFERENCES model_runs(id) ON DELETE CASCADE,
      document_version_id TEXT NOT NULL REFERENCES document_versions(id) ON DELETE CASCADE,
      base_revision INTEGER NOT NULL,base_html_hash TEXT NOT NULL,source_hash TEXT NOT NULL,
      source_snapshot_json TEXT NOT NULL,instruction TEXT NOT NULL,title TEXT NOT NULL,summary TEXT NOT NULL,changes_json TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','applied','dismissed','superseded')),
      applied_revision INTEGER,applied_change_ids_json TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,applied_at TEXT);
      CREATE TABLE IF NOT EXISTS summary_reviews(
      id TEXT PRIMARY KEY,artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
      model_run_id TEXT NOT NULL UNIQUE REFERENCES model_runs(id) ON DELETE CASCADE,
      document_version_id TEXT NOT NULL REFERENCES document_versions(id) ON DELETE CASCADE,
      artifact_version INTEGER NOT NULL,basis_revision INTEGER NOT NULL,basis_signal_hash TEXT NOT NULL,snapshot_json TEXT NOT NULL,
      decision TEXT CHECK(decision IS NULL OR decision IN ('KEEP','REPLACE')),result_json TEXT,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','applied','superseded','failed','cancelled')),
      created_at TEXT NOT NULL,applied_at TEXT);
      CREATE UNIQUE INDEX IF NOT EXISTS threads_one_writer_per_document_idx ON threads(document_id) WHERE kind='writer';
      CREATE UNIQUE INDEX IF NOT EXISTS writer_proposals_one_draft_per_thread_idx ON writer_proposals(thread_id) WHERE status='draft';
      CREATE UNIQUE INDEX IF NOT EXISTS model_runs_one_active_writer_idx ON model_runs(thread_id) WHERE action='document-write' AND status='running';
      CREATE UNIQUE INDEX IF NOT EXISTS edit_revisions_origin_idx ON document_edit_revisions(origin_type,origin_id) WHERE origin_id IS NOT NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS summary_reviews_one_pending_per_artifact_idx ON summary_reviews(artifact_id) WHERE status='pending';
      CREATE TRIGGER IF NOT EXISTS threads_kind_insert_guard BEFORE INSERT ON threads WHEN NEW.kind NOT IN ('discussion','writer') BEGIN SELECT RAISE(ABORT,'Invalid thread kind'); END;
      CREATE TRIGGER IF NOT EXISTS threads_kind_update_guard BEFORE UPDATE OF kind ON threads WHEN NEW.kind NOT IN ('discussion','writer') BEGIN SELECT RAISE(ABORT,'Invalid thread kind'); END;
      CREATE TRIGGER IF NOT EXISTS threads_annotation_candidate_insert_guard BEFORE INSERT ON threads WHEN NEW.annotation_candidate_status IS NOT NULL AND NEW.annotation_candidate_status NOT IN ('pending','accepted','dismissed') BEGIN SELECT RAISE(ABORT,'Invalid annotation candidate status'); END;
      CREATE TRIGGER IF NOT EXISTS threads_annotation_candidate_update_guard BEFORE UPDATE OF annotation_candidate_status ON threads WHEN NEW.annotation_candidate_status IS NOT NULL AND NEW.annotation_candidate_status NOT IN ('pending','accepted','dismissed') BEGIN SELECT RAISE(ABORT,'Invalid annotation candidate status'); END;`);
    db.prepare('INSERT INTO migrations(version,applied_at)VALUES(12,?)').run(new Date().toISOString());
    db.exec('COMMIT');
  }catch(error){db.exec('ROLLBACK');throw error}
}

// In-memory provider controllers cannot survive a process restart. Mark every
// durable "running" row terminal now so idempotent request replay and the
// one-active-Writer/review guards cannot remain stuck forever.
const interruptedAt=new Date().toISOString(),interruptedError='Interrupted by service restart';
db.exec('BEGIN IMMEDIATE');
try{
  db.prepare("UPDATE summary_reviews SET status='failed',result_json=? WHERE status='pending'").run(JSON.stringify({error:interruptedError}));
  db.prepare("UPDATE model_attempts SET status='failed',error=?,completed_at=? WHERE status='running'").run(interruptedError,interruptedAt);
  db.prepare("UPDATE model_runs SET status='failed',error=?,completed_at=? WHERE status='running'").run(interruptedError,interruptedAt);
  db.exec('COMMIT');
}catch(error){db.exec('ROLLBACK');throw error}

export function now(): string { return new Date().toISOString(); }
export function rows<T>(sql: string, ...params: any[]): T[] { return db.prepare(sql).all(...params) as T[]; }
export function row<T>(sql: string, ...params: any[]): T | undefined { return db.prepare(sql).get(...params) as T | undefined; }
