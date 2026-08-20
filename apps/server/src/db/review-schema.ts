export const reviewWorkflowSchema = `
CREATE TABLE IF NOT EXISTS import_review_issues (
  id TEXT PRIMARY KEY,
  import_job_id TEXT NOT NULL REFERENCES import_jobs(id) ON DELETE CASCADE,
  fingerprint TEXT NOT NULL,
  issue_code TEXT NOT NULL,
  severity TEXT NOT NULL CHECK(severity IN ('info','warning','error')),
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  verification_status TEXT NOT NULL DEFAULT 'unverified' CHECK(verification_status IN ('unverified','confirmed','rejected','resolved')),
  verification_reason TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','accepted','dismissed','manual')),
  confidence TEXT CHECK(confidence IS NULL OR confidence IN ('low','medium','high')),
  corroborated INTEGER NOT NULL DEFAULT 0,
  target_refs_json TEXT NOT NULL DEFAULT '[]',
  evidence_json TEXT NOT NULL DEFAULT '[]',
  source_actions_json TEXT NOT NULL DEFAULT '[]',
  policy_ids_json TEXT NOT NULL DEFAULT '[]',
  proposed_repair_json TEXT,
  repairable INTEGER NOT NULL DEFAULT 0,
  adjudication_json TEXT,
  adjudication_model_run_id TEXT REFERENCES model_runs(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(import_job_id,fingerprint)
);
CREATE TABLE IF NOT EXISTS import_review_issue_findings (
  issue_id TEXT NOT NULL REFERENCES import_review_issues(id) ON DELETE CASCADE,
  finding_id TEXT NOT NULL REFERENCES import_findings(id) ON DELETE CASCADE,
  PRIMARY KEY(issue_id,finding_id),
  UNIQUE(finding_id)
);
CREATE TABLE IF NOT EXISTS import_reviewer_feedback (
  id TEXT PRIMARY KEY,
  import_job_id TEXT NOT NULL REFERENCES import_jobs(id) ON DELETE CASCADE,
  review_issue_id TEXT NOT NULL REFERENCES import_review_issues(id) ON DELETE CASCADE,
  decision TEXT CHECK(decision IS NULL OR decision IN ('accepted','dismissed','manual')),
  reason TEXT,
  comment TEXT,
  reviewer_note TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS academic_reviewer_policies (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  priority INTEGER NOT NULL DEFAULT 100,
  match_json TEXT NOT NULL,
  action TEXT NOT NULL CHECK(action IN ('require-stronger-evidence','lower-priority','increase-scrutiny','context-note')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS import_review_adjudications (
  id TEXT PRIMARY KEY,
  import_job_id TEXT NOT NULL REFERENCES import_jobs(id) ON DELETE CASCADE,
  review_issue_id TEXT NOT NULL REFERENCES import_review_issues(id) ON DELETE CASCADE,
  model_run_id TEXT REFERENCES model_runs(id) ON DELETE SET NULL,
  report_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS import_repair_batches (
  id TEXT PRIMARY KEY,
  import_job_id TEXT NOT NULL REFERENCES import_jobs(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','accepted','reverted','stale','failed')),
  base_derivative_hash TEXT NOT NULL,
  candidate_derivative_hash TEXT,
  operations_json TEXT NOT NULL DEFAULT '[]',
  selected_operation_ids_json TEXT,
  validation_json TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  accepted_at TEXT,
  reverted_at TEXT
);
CREATE TABLE IF NOT EXISTS import_repair_batch_issues (
  repair_batch_id TEXT NOT NULL REFERENCES import_repair_batches(id) ON DELETE CASCADE,
  review_issue_id TEXT NOT NULL REFERENCES import_review_issues(id) ON DELETE CASCADE,
  PRIMARY KEY(repair_batch_id,review_issue_id)
);
CREATE TABLE IF NOT EXISTS import_review_revisions (
  id TEXT PRIMARY KEY,
  import_job_id TEXT NOT NULL REFERENCES import_jobs(id) ON DELETE CASCADE,
  repair_batch_id TEXT NOT NULL REFERENCES import_repair_batches(id) ON DELETE CASCADE,
  parent_revision_id TEXT REFERENCES import_review_revisions(id) ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED,
  status TEXT NOT NULL DEFAULT 'candidate' CHECK(status IN ('candidate','active','reverted','stale')),
  base_derivative_hash TEXT NOT NULL,
  candidate_derivative_hash TEXT NOT NULL,
  html_path TEXT NOT NULL,
  canonical_hash TEXT NOT NULL,
  inventory_hash TEXT NOT NULL,
  operations_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  activated_at TEXT,
  reverted_at TEXT,
  UNIQUE(repair_batch_id,candidate_derivative_hash)
);
CREATE INDEX IF NOT EXISTS import_review_issues_job_idx ON import_review_issues(import_job_id,updated_at);
CREATE INDEX IF NOT EXISTS import_reviewer_feedback_issue_idx ON import_reviewer_feedback(review_issue_id,created_at);
CREATE INDEX IF NOT EXISTS academic_reviewer_policies_priority_idx ON academic_reviewer_policies(enabled,priority,id);
CREATE INDEX IF NOT EXISTS import_repair_batches_job_idx ON import_repair_batches(import_job_id,created_at);
CREATE INDEX IF NOT EXISTS import_review_revisions_parent_idx ON import_review_revisions(parent_revision_id);
CREATE UNIQUE INDEX IF NOT EXISTS import_review_revisions_one_active_job_idx ON import_review_revisions(import_job_id) WHERE status='active';
`;
