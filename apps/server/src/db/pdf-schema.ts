import type { DatabaseSync } from 'node:sqlite';

export const pdfSchema = `
CREATE TABLE IF NOT EXISTS document_representations (
 id TEXT PRIMARY KEY, document_version_id TEXT NOT NULL REFERENCES document_versions(id) ON DELETE CASCADE,
 kind TEXT NOT NULL CHECK(kind IN ('html','pdf')), status TEXT NOT NULL DEFAULT 'ready',
 source_hash TEXT, source_path TEXT, pdf_hash TEXT, pdf_path TEXT,
 source_page_start INTEGER, source_page_end INTEGER, page_count INTEGER,
 ocr_language TEXT NOT NULL DEFAULT 'eng', extraction_revision INTEGER NOT NULL DEFAULT 0,
 error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(document_version_id,kind));
CREATE TABLE IF NOT EXISTS document_view_preferences (
 document_id TEXT PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
 representation_id TEXT REFERENCES document_representations(id) ON DELETE SET NULL);
CREATE TABLE IF NOT EXISTS representation_progress (
 representation_id TEXT PRIMARY KEY REFERENCES document_representations(id) ON DELETE CASCADE,
 page INTEGER NOT NULL DEFAULT 1, offset_ratio REAL NOT NULL DEFAULT 0, zoom REAL NOT NULL DEFAULT 1,
 rotation INTEGER NOT NULL DEFAULT 0, last_thread_id TEXT, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS pdf_page_revisions (
 representation_id TEXT NOT NULL REFERENCES document_representations(id) ON DELETE CASCADE,
 revision INTEGER NOT NULL, page INTEGER NOT NULL, data_json TEXT NOT NULL,
 PRIMARY KEY(representation_id,revision,page));
CREATE TABLE IF NOT EXISTS pdf_index_jobs (
 id TEXT PRIMARY KEY, representation_id TEXT NOT NULL REFERENCES document_representations(id) ON DELETE CASCADE,
 pages_json TEXT NOT NULL, completed_json TEXT NOT NULL DEFAULT '[]', force_ocr INTEGER NOT NULL DEFAULT 0,
 language TEXT NOT NULL DEFAULT 'eng', status TEXT NOT NULL DEFAULT 'queued', error TEXT,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS pdf_index_one_active ON pdf_index_jobs(representation_id) WHERE status IN ('queued','running');
CREATE TABLE IF NOT EXISTS source_citations (
 id TEXT PRIMARY KEY, model_run_id TEXT NOT NULL REFERENCES model_runs(id) ON DELETE CASCADE,
 evidence_id TEXT NOT NULL, label TEXT NOT NULL, selector_json TEXT NOT NULL,
 UNIQUE(model_run_id,evidence_id));
CREATE TABLE IF NOT EXISTS pdf_run_basis (
 model_run_id TEXT PRIMARY KEY REFERENCES model_runs(id) ON DELETE CASCADE,
 representation_id TEXT NOT NULL REFERENCES document_representations(id) ON DELETE CASCADE,
 extraction_revision INTEGER NOT NULL, evidence_json TEXT NOT NULL);
CREATE VIRTUAL TABLE IF NOT EXISTS pdf_search_index USING fts5(representation_id UNINDEXED,page UNINDEXED,body,tokenize='unicode61');
`;

export function migratePdfSchema(db: DatabaseSync): void {
  if (db.prepare('SELECT 1 FROM migrations WHERE version=20').get()) return;
  db.exec('PRAGMA foreign_keys=OFF');
  db.exec('BEGIN IMMEDIATE');
  try {
    // Rebuild without renaming the old parent first: child foreign-key targets
    // continue to refer to document_versions, including legacy saved anchors.
    db.exec(`CREATE TABLE document_versions_pdf (
      id TEXT PRIMARY KEY, document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      content_hash TEXT NOT NULL UNIQUE, source_name TEXT NOT NULL, entry_path TEXT,
      sanitized_html_path TEXT, canonical_text TEXT NOT NULL, token_estimate INTEGER NOT NULL,
      version INTEGER NOT NULL, created_at TEXT NOT NULL, UNIQUE(document_id,version));
      INSERT INTO document_versions_pdf SELECT id,document_id,content_hash,source_name,entry_path,sanitized_html_path,canonical_text,token_estimate,version,created_at FROM document_versions;
      DROP TABLE document_versions;
      ALTER TABLE document_versions_pdf RENAME TO document_versions;`);
    db.exec(pdfSchema);
    db.exec(`ALTER TABLE anchors ADD COLUMN representation_id TEXT REFERENCES document_representations(id) ON DELETE CASCADE;
      ALTER TABLE anchors ADD COLUMN selector_json TEXT;
      ALTER TABLE threads ADD COLUMN representation_id TEXT REFERENCES document_representations(id) ON DELETE SET NULL;
      ALTER TABLE messages ADD COLUMN model_run_id TEXT REFERENCES model_runs(id) ON DELETE SET NULL;
      ALTER TABLE artifacts ADD COLUMN representation_id TEXT REFERENCES document_representations(id) ON DELETE CASCADE;
      ALTER TABLE artifacts ADD COLUMN basis_extraction_revision INTEGER;
      ALTER TABLE import_jobs ADD COLUMN reading_format TEXT NOT NULL DEFAULT 'html';
      ALTER TABLE import_jobs ADD COLUMN ocr_language TEXT NOT NULL DEFAULT 'eng';
      ALTER TABLE import_jobs ADD COLUMN pdf_target_version_id TEXT REFERENCES document_versions(id) ON DELETE SET NULL;
      INSERT INTO document_representations(id,document_version_id,kind,status,created_at,updated_at)
        SELECT 'html-'||id,id,'html','ready',created_at,created_at FROM document_versions WHERE sanitized_html_path IS NOT NULL;
      UPDATE anchors SET representation_id='html-'||document_version_id;
      UPDATE threads SET representation_id=(SELECT representation_id FROM anchors WHERE anchors.id=threads.anchor_id);
      UPDATE artifacts SET representation_id=NULL;`);
    db.exec(`CREATE TRIGGER document_version_html_representation AFTER INSERT ON document_versions WHEN NEW.sanitized_html_path IS NOT NULL BEGIN
      INSERT OR IGNORE INTO document_representations(id,document_version_id,kind,status,created_at,updated_at)
        VALUES('html-'||NEW.id,NEW.id,'html','ready',NEW.created_at,NEW.created_at);
      END;
      CREATE TRIGGER anchor_html_representation AFTER INSERT ON anchors WHEN NEW.selector_json IS NULL AND NEW.representation_id IS NULL BEGIN
        UPDATE anchors SET representation_id=(SELECT id FROM document_representations WHERE document_version_id=NEW.document_version_id AND kind='html') WHERE id=NEW.id;
      END;`);
    const errors = db.prepare('PRAGMA foreign_key_check').all();
    if (errors.length) throw new Error('PDF migration failed foreign-key validation');
    db.prepare('INSERT INTO migrations(version,applied_at)VALUES(20,?)').run(new Date().toISOString());
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  finally { db.exec('PRAGMA foreign_keys=ON'); }
}
