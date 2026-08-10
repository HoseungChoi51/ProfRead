import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../config.js';
import { schema } from './schema.js';

mkdirSync(config.dataDir, { recursive: true });
mkdirSync(join(config.dataDir, 'documents'), { recursive: true });
mkdirSync(join(config.dataDir, 'exports'), { recursive: true });
mkdirSync(join(config.dataDir, 'generated'), { recursive: true });
mkdirSync(join(config.dataDir, 'edits'), { recursive: true });
export const db = new DatabaseSync(join(config.dataDir, 'co-reader.sqlite'));
db.exec(schema);
let blockColumns=db.prepare('PRAGMA table_info(blocks)').all() as Array<{name:string;pk:number}>;
if(!blockColumns.some(column=>column.name==='visual_data')){db.exec('ALTER TABLE blocks ADD COLUMN visual_data TEXT');blockColumns=db.prepare('PRAGMA table_info(blocks)').all() as Array<{name:string;pk:number}>}
if(blockColumns.find(column=>column.name==='id')?.pk===1&&blockColumns.find(column=>column.name==='document_version_id')?.pk===0){db.exec(`BEGIN IMMEDIATE;ALTER TABLE blocks RENAME TO blocks_legacy;CREATE TABLE blocks(id TEXT NOT NULL,document_version_id TEXT NOT NULL REFERENCES document_versions(id) ON DELETE CASCADE,ordinal INTEGER NOT NULL,block_type TEXT NOT NULL,text_content TEXT NOT NULL,visual_data TEXT,start_offset INTEGER NOT NULL,end_offset INTEGER NOT NULL,PRIMARY KEY(document_version_id,id),UNIQUE(document_version_id,ordinal));INSERT INTO blocks(id,document_version_id,ordinal,block_type,text_content,visual_data,start_offset,end_offset)SELECT id,document_version_id,ordinal,block_type,text_content,visual_data,start_offset,end_offset FROM blocks_legacy;DROP TABLE blocks_legacy;COMMIT;`);blockColumns=db.prepare('PRAGMA table_info(blocks)').all() as Array<{name:string;pk:number}>}
const sessionColumns=db.prepare('PRAGMA table_info(sessions)').all() as Array<{name:string}>;
if(!sessionColumns.some(column=>column.name==='csrf_hash'))db.exec("ALTER TABLE sessions ADD COLUMN csrf_hash TEXT NOT NULL DEFAULT ''");
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

export function now(): string { return new Date().toISOString(); }
export function rows<T>(sql: string, ...params: any[]): T[] { return db.prepare(sql).all(...params) as T[]; }
export function row<T>(sql: string, ...params: any[]): T | undefined { return db.prepare(sql).get(...params) as T | undefined; }
