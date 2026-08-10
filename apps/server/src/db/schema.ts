export const schema = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, csrf_hash TEXT NOT NULL, expires_at TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS article_groups (id TEXT PRIMARY KEY, name TEXT NOT NULL COLLATE NOCASE UNIQUE, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS documents (id TEXT PRIMARY KEY, title TEXT NOT NULL, group_id TEXT REFERENCES article_groups(id) ON DELETE SET NULL, created_at TEXT NOT NULL, last_opened_at TEXT);
CREATE TABLE IF NOT EXISTS document_tags (document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,tag TEXT NOT NULL,PRIMARY KEY(document_id,tag));
CREATE TABLE IF NOT EXISTS document_versions (
 id TEXT PRIMARY KEY, document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE, content_hash TEXT NOT NULL UNIQUE,
 source_name TEXT NOT NULL, entry_path TEXT NOT NULL, sanitized_html_path TEXT NOT NULL, canonical_text TEXT NOT NULL,
 token_estimate INTEGER NOT NULL, version INTEGER NOT NULL, created_at TEXT NOT NULL, UNIQUE(document_id, version));
CREATE TABLE IF NOT EXISTS document_edit_revisions (
 id TEXT PRIMARY KEY, document_version_id TEXT NOT NULL REFERENCES document_versions(id) ON DELETE CASCADE,
 revision INTEGER NOT NULL, edited_html_path TEXT NOT NULL, canonical_text TEXT NOT NULL, base_title TEXT NOT NULL,
 summary_json TEXT NOT NULL, restored_from_revision INTEGER, created_at TEXT NOT NULL,
 UNIQUE(document_version_id, revision));
CREATE TABLE IF NOT EXISTS assets (
 id TEXT PRIMARY KEY, document_version_id TEXT NOT NULL REFERENCES document_versions(id) ON DELETE CASCADE,
 source_path TEXT NOT NULL, content_hash TEXT NOT NULL, mime_type TEXT NOT NULL, storage_path TEXT NOT NULL,
 byte_size INTEGER NOT NULL, UNIQUE(document_version_id, source_path));
CREATE TABLE IF NOT EXISTS blocks (
 id TEXT NOT NULL, document_version_id TEXT NOT NULL REFERENCES document_versions(id) ON DELETE CASCADE,
 ordinal INTEGER NOT NULL, block_type TEXT NOT NULL, text_content TEXT NOT NULL, visual_data TEXT, start_offset INTEGER NOT NULL, end_offset INTEGER NOT NULL,
 PRIMARY KEY(document_version_id,id),UNIQUE(document_version_id, ordinal));
CREATE TABLE IF NOT EXISTS anchors (
 id TEXT PRIMARY KEY, document_version_id TEXT NOT NULL REFERENCES document_versions(id) ON DELETE CASCADE, block_id TEXT NOT NULL,
 exact_quote TEXT NOT NULL, prefix_text TEXT NOT NULL, suffix_text TEXT NOT NULL, start_offset INTEGER NOT NULL, end_offset INTEGER NOT NULL,
 block_type TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'attached', migrated_from_id TEXT, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS highlights (id TEXT PRIMARY KEY, anchor_id TEXT NOT NULL REFERENCES anchors(id) ON DELETE CASCADE, checked INTEGER NOT NULL DEFAULT 0, color TEXT NOT NULL DEFAULT 'yellow', note TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS threads (id TEXT PRIMARY KEY, document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE, anchor_id TEXT REFERENCES anchors(id) ON DELETE SET NULL, parent_message_id TEXT, title TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE, parent_message_id TEXT REFERENCES messages(id) ON DELETE CASCADE, role TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS model_runs (
 id TEXT PRIMARY KEY, thread_id TEXT REFERENCES threads(id) ON DELETE SET NULL, request_id TEXT NOT NULL UNIQUE, action TEXT NOT NULL,
 provider_id TEXT, model_id TEXT, profile TEXT NOT NULL, routing_reason TEXT NOT NULL, context_tier TEXT NOT NULL, fallback_model_id TEXT,
 status TEXT NOT NULL, ttft_ms INTEGER, latency_ms INTEGER, input_tokens INTEGER, output_tokens INTEGER, provider_response_id TEXT, response_text TEXT, error TEXT, created_at TEXT NOT NULL, completed_at TEXT);
CREATE TABLE IF NOT EXISTS model_attempts (id TEXT PRIMARY KEY,model_run_id TEXT NOT NULL REFERENCES model_runs(id) ON DELETE CASCADE,model_id TEXT NOT NULL,provider_id TEXT NOT NULL,attempt INTEGER NOT NULL,status TEXT NOT NULL,error TEXT,started_at TEXT NOT NULL,completed_at TEXT);
CREATE TABLE IF NOT EXISTS citations (id TEXT PRIMARY KEY, model_run_id TEXT NOT NULL REFERENCES model_runs(id) ON DELETE CASCADE, title TEXT, url TEXT NOT NULL, start_offset INTEGER, end_offset INTEGER);
CREATE TABLE IF NOT EXISTS tool_events (id TEXT PRIMARY KEY, model_run_id TEXT NOT NULL REFERENCES model_runs(id) ON DELETE CASCADE, event_type TEXT NOT NULL, tool_name TEXT NOT NULL, payload_json TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS artifacts (id TEXT PRIMARY KEY, document_version_id TEXT NOT NULL REFERENCES document_versions(id) ON DELETE CASCADE, kind TEXT NOT NULL, version INTEGER NOT NULL, scope_type TEXT NOT NULL, scope_id TEXT NOT NULL, content_json TEXT NOT NULL, source_refs_json TEXT NOT NULL, promoted INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, UNIQUE(kind, scope_type, scope_id, version));
CREATE TABLE IF NOT EXISTS background_jobs (id TEXT PRIMARY KEY, kind TEXT NOT NULL, document_version_id TEXT REFERENCES document_versions(id) ON DELETE CASCADE, status TEXT NOT NULL, progress REAL NOT NULL DEFAULT 0, result_json TEXT, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS model_settings (id TEXT PRIMARY KEY, provider_id TEXT NOT NULL, label TEXT NOT NULL, protocol TEXT NOT NULL, base_url TEXT, secret_env_name TEXT NOT NULL, config_json TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, UNIQUE(provider_id));
CREATE TABLE IF NOT EXISTS model_definitions (id TEXT PRIMARY KEY, provider_id TEXT NOT NULL, label TEXT NOT NULL, protocol TEXT NOT NULL, context_window INTEGER NOT NULL, max_output INTEGER NOT NULL, capabilities_json TEXT NOT NULL, priority INTEGER NOT NULL DEFAULT 100, enabled INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS model_profiles (name TEXT PRIMARY KEY, model_ids_json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS task_model_routes (action TEXT PRIMARY KEY, model_id TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS prompt_template_overrides (key TEXT PRIMARY KEY, template TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS behavior_settings (id TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS context_cache (document_version_id TEXT NOT NULL REFERENCES document_versions(id) ON DELETE CASCADE, tier TEXT NOT NULL, content TEXT NOT NULL, token_estimate INTEGER NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(document_version_id, tier));
CREATE TABLE IF NOT EXISTS branch_digests (thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,version INTEGER NOT NULL,message_count INTEGER NOT NULL,content TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(thread_id,version));
CREATE TABLE IF NOT EXISTS reading_progress (document_id TEXT PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE, block_id TEXT, offset_ratio REAL NOT NULL DEFAULT 0, last_thread_id TEXT, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS export_history (id TEXT PRIMARY KEY, document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE, format TEXT NOT NULL, options_json TEXT NOT NULL, storage_path TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE VIRTUAL TABLE IF NOT EXISTS search_index USING fts5(kind, entity_id UNINDEXED, document_id UNINDEXED, title, body, tags, model_id UNINDEXED, created_at UNINDEXED, tokenize='porter unicode61');
`;
