import { createHash } from 'node:crypto';
import {
  summaryBasisSchema,
  summaryReviewResultSchema,
  summaryReviewToolName,
  visualRecapSchema,
  type SummaryBasis,
  type SummaryFreshness,
  type SummaryReviewResult,
} from '@afterdraft/shared';
import { nanoid } from 'nanoid';
import { db, now, row, rows } from '../db/index.js';
import { promptTemplate, renderPrompt } from './prompts.js';

export type SummaryArtifactKind = 'tldr' | 'half-page' | 'visual-recap';
export type SummaryReviewTerminalStatus = 'applied' | 'superseded' | 'failed' | 'cancelled';

export type SummaryReviewSignal = {
  id: string;
  kind: 'important' | 'comment';
  exactQuote: string;
  note: string | null;
};

type StoredSummaryArtifact = {
  id: string;
  document_version_id: string;
  artifact_document_id: string;
  kind: string;
  version: number;
  scope_type: string;
  scope_id: string;
  content_json: string;
  source_refs_json: string;
  promoted: number;
  created_at: string;
  basis_document_version_id: string | null;
  basis_revision: number | null;
  basis_signal_hash: string | null;
};

type StoredReview = {
  id: string;
  artifact_id: string;
  model_run_id: string;
  document_version_id: string;
  artifact_version: number;
  basis_revision: number;
  basis_signal_hash: string;
  snapshot_json: string;
  decision: SummaryReviewResult['decision'] | null;
  result_json: string | null;
  status: 'pending' | SummaryReviewTerminalStatus;
  created_at: string;
  applied_at: string | null;
  model_id?: string | null;
};

export type SummaryReviewSnapshot = {
  artifactId: string;
  artifactVersion: number;
  artifactKind: SummaryArtifactKind;
  artifactContent: unknown;
  sourceRefs: string[];
  documentId: string;
  documentVersionId: string;
  article: string;
  articleHash: string;
  signals: SummaryReviewSignal[];
  basis: SummaryBasis;
  freshness: SummaryFreshness;
};

type AuditedSummaryReviewSnapshot = Omit<SummaryReviewSnapshot, 'article'>;

export type SummaryReviewOutcome = {
  reviewId: string;
  artifactId: string;
  artifactVersion: number;
  decision: SummaryReviewResult['decision'];
  applied: boolean;
  rationale: string;
  sourceStatus: SummaryReviewResult['sourceStatus'];
  basis: SummaryBasis;
  freshness: SummaryFreshness;
  supersededReason?: 'artifact-changed' | 'basis-changed';
};

export type SummaryReviewReplay = {
  reviewId: string;
  artifactId: string;
  modelRunId: string;
  status: 'pending' | SummaryReviewTerminalStatus;
  decision: SummaryReviewResult['decision'] | null;
  snapshot: AuditedSummaryReviewSnapshot;
  outcome?: SummaryReviewOutcome;
  error?: string;
  createdAt: string;
  appliedAt: string | null;
};

export type LatestSummaryReview = {
  id: string;
  status: 'pending' | SummaryReviewTerminalStatus;
  decision: SummaryReviewResult['decision'] | null;
  rationale: string | null;
  sourceStatus: SummaryReviewResult['sourceStatus'] | null;
  modelId: string | null;
  artifactVersion: number;
  basis: SummaryBasis;
  createdAt: string;
  appliedAt: string | null;
};

export class SummaryReviewError extends Error {
  constructor(message: string, readonly statusCode: 400 | 404 | 409 | 422 = 409) {
    super(message);
    this.name = 'SummaryReviewError';
  }
}

const strictString=()=>({type:'string'} as const);
const strictStringArray=(maxItems:number)=>({type:'array',items:strictString(),maxItems} as const);
const strictObject=(properties:Record<string,unknown>)=>({type:'object',properties,required:Object.keys(properties),additionalProperties:false} as const);
const recapSchema=strictObject({
  version:{type:'integer',enum:[1]},
  title:strictString(),
  thesis:strictString(),
  sections:{type:'array',maxItems:6,items:strictObject({title:strictString(),summary:strictString(),sourceRefs:strictStringArray(12)})},
  relationships:{type:'array',maxItems:20,items:strictObject({from:strictString(),to:strictString(),relation:strictString()})},
  takeaways:{type:'array',maxItems:12,items:strictString()},
  openQuestions:{type:'array',maxItems:12,items:strictString()},
  sourceRefs:{type:'array',maxItems:40,items:strictString()},
});
const replacementSchema={anyOf:[
  strictObject({kind:{type:'string',enum:['tldr']},content:strictString()}),
  strictObject({kind:{type:'string',enum:['half-page']},content:strictString()}),
  strictObject({kind:{type:'string',enum:['visual-recap']},content:recapSchema}),
]} as const;
export const summaryReviewTool={name:summaryReviewToolName,schema:strictObject({
  decision:{type:'string',enum:['KEEP','REPLACE']},
  rationale:strictString(),
  sourceStatus:{type:'string',enum:['adequate','material-gap','contradiction']},
  signalCoverage:{type:'array',maxItems:200,items:strictObject({
    signalId:strictString(),
    status:{type:'string',enum:['covered','missing','contradicted']},
    explanation:{description:'Use null when no explanation is needed.',anyOf:[strictString(),{type:'null'}]},
  })},
  replacement:{description:'Use null when decision is KEEP; provide the complete matching-kind object when decision is REPLACE.',anyOf:[{type:'null'},...replacementSchema.anyOf]},
})} as const;

const summaryKinds = new Set<SummaryArtifactKind>(['tldr', 'half-page', 'visual-recap']);
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const sameBasis = (left: SummaryBasis, right: SummaryBasis) => left.documentVersionId === right.documentVersionId && left.revision === right.revision && left.signalHash === right.signalHash;

function reviewSignals(documentVersionId: string): SummaryReviewSignal[] {
  return rows<{ id: string; kind: string; exact_quote: string; note: string | null }>(`SELECT h.id,h.kind,a.exact_quote,h.note
    FROM highlights h JOIN anchors a ON a.id=h.anchor_id
    WHERE a.document_version_id=? AND h.kind IN ('important','comment') ORDER BY h.id`, documentVersionId).map(signal => ({
    id: signal.id,
    kind: signal.kind as SummaryReviewSignal['kind'],
    exactQuote: signal.exact_quote,
    note: signal.note?.trim() || null,
  }));
}

export function summaryBasis(documentVersionId: string): SummaryBasis {
  if (!row('SELECT id FROM document_versions WHERE id=?', documentVersionId)) throw new SummaryReviewError('Document version not found', 404);
  const revision = row<{ revision: number }>('SELECT COALESCE(MAX(revision),0) revision FROM document_edit_revisions WHERE document_version_id=?', documentVersionId)?.revision ?? 0;
  const signalHash = sha256(JSON.stringify(reviewSignals(documentVersionId)));
  return summaryBasisSchema.parse({ documentVersionId, revision, signalHash });
}

export function summaryFreshness(artifact: Pick<StoredSummaryArtifact, 'basis_document_version_id' | 'basis_revision' | 'basis_signal_hash'>, current: SummaryBasis): SummaryFreshness {
  if (artifact.basis_document_version_id === null || artifact.basis_revision === null || artifact.basis_signal_hash === null) return { status: 'unknown', reasons: ['missing-basis'] };
  const reasons: SummaryFreshness['reasons'] = [];
  if (artifact.basis_document_version_id !== current.documentVersionId) reasons.push('document-version-changed');
  if (artifact.basis_revision !== current.revision) reasons.push('document-edits-changed');
  if (artifact.basis_signal_hash !== current.signalHash) reasons.push('reader-signals-changed');
  return { status: reasons.length ? 'needs-review' : 'current', reasons };
}

export function validateSummaryArtifactContent(kind: SummaryArtifactKind, content: unknown): unknown {
  if (kind === 'visual-recap') return visualRecapSchema.parse(content);
  if (typeof content !== 'string') throw new SummaryReviewError('Text summary content must be a string', 422);
  const trimmed = content.trim();
  if (!trimmed) throw new SummaryReviewError('Summary content cannot be empty', 422);
  const cjkPattern=/[\p{Script=Han}\p{Script=Hangul}\p{Script=Hiragana}\p{Script=Katakana}]/gu;
  const cjkUnits=(trimmed.match(cjkPattern)??[]).length;
  const nonCjkWords=trimmed.replace(cjkPattern,' ').match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu)?.length??0;
  const lengthUnits=cjkUnits+nonCjkWords;
  const bulletCount=(trimmed.match(/^\s*(?:[-*+]|\d+[.)])\s+/gm)??[]).length;
  if (kind === 'tldr' && (lengthUnits > 150 || bulletCount > 5)) throw new SummaryReviewError('TL;DR must contain at most five bullets and 150 words or CJK characters', 422);
  if (kind === 'half-page' && (lengthUnits < 300 || lengthUnits > 450)) throw new SummaryReviewError('Half-page summary must contain 300 to 450 words or CJK characters', 422);
  return trimmed;
}

function validateStoredSummaryArtifactContent(kind:SummaryArtifactKind,content:unknown):unknown{
  if(kind==='visual-recap')return visualRecapSchema.parse(content);
  if(typeof content!=='string'||!content.trim())throw new SummaryReviewError('Stored text summary content is invalid',422);
  return content.trim();
}

export function prepareSummaryReview(input: { artifactId: string; expectedArtifactVersion: number; documentId: string; documentVersionId: string }): SummaryReviewSnapshot {
  if (!Number.isInteger(input.expectedArtifactVersion) || input.expectedArtifactVersion < 1) throw new SummaryReviewError('Expected artifact version must be a positive integer', 400);
  const artifact = row<StoredSummaryArtifact>(`SELECT a.*,v.document_id artifact_document_id
    FROM artifacts a JOIN document_versions v ON v.id=a.document_version_id WHERE a.id=?`, input.artifactId);
  if (!artifact) throw new SummaryReviewError('Summary artifact not found', 404);
  if (artifact.scope_type !== 'document' || !summaryKinds.has(artifact.kind as SummaryArtifactKind)) throw new SummaryReviewError('Artifact does not support semantic summary review', 409);
  if (artifact.scope_id !== input.documentId || artifact.artifact_document_id !== input.documentId) throw new SummaryReviewError('Summary artifact does not belong to the supplied document', 409);
  const latest = row<{ id: string; canonical_text: string }>(`SELECT v.id,COALESCE(
      (SELECT edit.canonical_text FROM document_edit_revisions edit WHERE edit.document_version_id=v.id ORDER BY edit.revision DESC LIMIT 1),
      v.canonical_text
    ) canonical_text FROM document_versions v WHERE v.document_id=? ORDER BY v.version DESC LIMIT 1`, input.documentId);
  if (!latest) throw new SummaryReviewError('Artifact document not found', 404);
  if (latest.id !== input.documentVersionId) throw new SummaryReviewError('Summary review must use the latest document version', 409);
  if (artifact.version !== input.expectedArtifactVersion) throw new SummaryReviewError('Summary artifact changed; reload before reviewing', 409);
  const basis = summaryBasis(latest.id), freshness = summaryFreshness(artifact, basis);
  if (freshness.status === 'current') throw new SummaryReviewError('Summary is already current', 409);
  const signals = reviewSignals(latest.id);
  if (signals.length > 200) throw new SummaryReviewError('Summary review supports at most 200 Important and Comment signals', 422);
  const artifactKind = artifact.kind as SummaryArtifactKind;
  let artifactContent: unknown, sourceRefs: string[];
  try {
    artifactContent = validateStoredSummaryArtifactContent(artifactKind, JSON.parse(artifact.content_json));
    const parsedRefs = JSON.parse(artifact.source_refs_json) as unknown;
    if (!Array.isArray(parsedRefs) || parsedRefs.some(value => typeof value !== 'string')) throw new Error('invalid source references');
    sourceRefs = parsedRefs;
  } catch (error) {
    if (error instanceof SummaryReviewError) throw error;
    throw new SummaryReviewError('Stored summary artifact is invalid', 422);
  }
  return {
    artifactId: artifact.id,
    artifactVersion: artifact.version,
    artifactKind,
    artifactContent,
    sourceRefs,
    documentId: input.documentId,
    documentVersionId: latest.id,
    article: latest.canonical_text,
    articleHash: sha256(latest.canonical_text),
    signals,
    basis,
    freshness,
  };
}

export function formatSummaryReviewInput(snapshot: SummaryReviewSnapshot): string {
  return renderPrompt('summary-review.envelope', {
    articleText: snapshot.article,
    artifactKind: snapshot.artifactKind,
    existingSummary: JSON.stringify(snapshot.artifactContent),
    freshnessReasons: snapshot.freshness.reasons.join(', '),
    readerSignals: JSON.stringify(snapshot.signals),
    contract: promptTemplate('contract.review-summary'),
  });
}

function auditedSnapshot(snapshot: SummaryReviewSnapshot): AuditedSummaryReviewSnapshot {
  const { article, ...audited } = snapshot;
  if (sha256(article) !== snapshot.articleHash) throw new SummaryReviewError('Summary review article snapshot hash does not match', 409);
  return audited;
}

function parseAuditedSnapshot(value: string): AuditedSummaryReviewSnapshot {
  const snapshot = JSON.parse(value) as AuditedSummaryReviewSnapshot;
  summaryBasisSchema.parse(snapshot.basis);
  if (!summaryKinds.has(snapshot.artifactKind) || !Number.isInteger(snapshot.artifactVersion)) throw new Error('Invalid summary review snapshot');
  return snapshot;
}

function readReviewById(reviewId: string): StoredReview | undefined {
  return row<StoredReview>('SELECT * FROM summary_reviews WHERE id=?', reviewId);
}

function replayFromRow(review: StoredReview): SummaryReviewReplay {
  const snapshot = parseAuditedSnapshot(review.snapshot_json), parsed = review.result_json ? JSON.parse(review.result_json) as Record<string, unknown> : undefined;
  const outcomeCandidate = parsed?.outcome && typeof parsed.outcome === 'object' ? parsed.outcome as Record<string, unknown> : parsed;
  const outcome = outcomeCandidate && typeof outcomeCandidate.applied === 'boolean' ? outcomeCandidate as unknown as SummaryReviewOutcome : undefined;
  const error = parsed && typeof parsed.error === 'string' ? parsed.error : undefined;
  return {
    reviewId: review.id,
    artifactId: review.artifact_id,
    modelRunId: review.model_run_id,
    status: review.status,
    decision: review.decision,
    snapshot,
    ...(outcome ? { outcome } : {}),
    ...(error ? { error } : {}),
    createdAt: review.created_at,
    appliedAt: review.applied_at,
  };
}

export function startSummaryReview(modelRunId: string, snapshot: SummaryReviewSnapshot): SummaryReviewReplay {
  const existing = row<StoredReview>('SELECT * FROM summary_reviews WHERE model_run_id=?', modelRunId);
  if (existing) return replayFromRow(existing);
  const reviewId = nanoid(), createdAt = now();
  try {
    db.prepare(`INSERT INTO summary_reviews(id,artifact_id,model_run_id,document_version_id,artifact_version,basis_revision,basis_signal_hash,snapshot_json,decision,result_json,status,created_at,applied_at)
      VALUES(?,?,?,?,?,?,?,?,NULL,NULL,'pending',?,NULL)`).run(reviewId, snapshot.artifactId, modelRunId, snapshot.basis.documentVersionId, snapshot.artifactVersion, snapshot.basis.revision, snapshot.basis.signalHash, JSON.stringify(auditedSnapshot(snapshot)), createdAt);
  } catch (error) {
    const pending = row<StoredReview>("SELECT * FROM summary_reviews WHERE artifact_id=? AND status='pending'", snapshot.artifactId);
    if (pending) throw new SummaryReviewError('A semantic review is already running for this summary', 409);
    throw error;
  }
  return replayFromRow(readReviewById(reviewId)!);
}

export function replaySummaryReview(modelRunId: string): SummaryReviewReplay | undefined {
  const review = row<StoredReview>('SELECT * FROM summary_reviews WHERE model_run_id=?', modelRunId);
  return review ? replayFromRow(review) : undefined;
}

export function failSummaryReview(reviewId: string, error: unknown, status: 'failed' | 'cancelled' = 'failed'): SummaryReviewReplay {
  const review = readReviewById(reviewId);
  if (!review) throw new SummaryReviewError('Summary review not found', 404);
  if (review.status !== 'pending') return replayFromRow(review);
  const message = error instanceof Error ? error.message : String(error);
  db.prepare('UPDATE summary_reviews SET status=?,result_json=? WHERE id=? AND status=\'pending\'').run(status, JSON.stringify({ error: message }), reviewId);
  return replayFromRow(readReviewById(reviewId)!);
}

export function parseSummaryReviewToolInput(value: unknown): SummaryReviewResult {
  let candidate = value;
  if (typeof value === 'string') {
    try { candidate = JSON.parse(value); }
    catch { throw new SummaryReviewError('Summary review returned invalid JSON', 422); }
  }
  if(candidate&&typeof candidate==='object'&&!Array.isArray(candidate)){
    const normalized={...(candidate as Record<string,unknown>)};
    if(normalized.replacement===null)delete normalized.replacement;
    if(Array.isArray(normalized.signalCoverage))normalized.signalCoverage=normalized.signalCoverage.map(item=>{
      if(!item||typeof item!=='object'||Array.isArray(item))return item;
      const coverage={...(item as Record<string,unknown>)};if(coverage.explanation===null)delete coverage.explanation;return coverage;
    });
    candidate=normalized;
  }
  try { return summaryReviewResultSchema.parse(candidate); }
  catch (error) { throw new SummaryReviewError(`Summary review result is invalid: ${error instanceof Error ? error.message : 'schema validation failed'}`, 422); }
}

function validateSignalCoverage(snapshot: AuditedSummaryReviewSnapshot, result: SummaryReviewResult): void {
  const expected = new Set(snapshot.signals.map(signal => signal.id)), seen = new Set<string>();
  for (const coverage of result.signalCoverage) {
    if (!expected.has(coverage.signalId)) throw new SummaryReviewError(`Summary review cited an unknown signal: ${coverage.signalId}`, 422);
    if (seen.has(coverage.signalId)) throw new SummaryReviewError(`Summary review duplicated signal coverage: ${coverage.signalId}`, 422);
    seen.add(coverage.signalId);
  }
  const missing = [...expected].filter(id => !seen.has(id));
  if (missing.length) throw new SummaryReviewError(`Summary review omitted signal coverage: ${missing.join(', ')}`, 422);
}

function replacementFor(snapshot: AuditedSummaryReviewSnapshot, result: SummaryReviewResult, visualImage?: unknown): { content: unknown; sourceRefs: string[] } | undefined {
  validateSignalCoverage(snapshot, result);
  if (result.decision === 'KEEP') return;
  if (result.replacement.kind !== snapshot.artifactKind) throw new SummaryReviewError('Summary review replacement kind does not match the artifact', 422);
  let content: unknown = result.replacement.content;
  if (result.replacement.kind === 'visual-recap') {
    if (visualImage === undefined) throw new SummaryReviewError('Visual recap replacement requires a generated image', 422);
    content = { ...result.replacement.content, image: visualImage };
  }
  content = validateSummaryArtifactContent(snapshot.artifactKind, content);
  const recapRefs = snapshot.artifactKind === 'visual-recap' && typeof content === 'object' && content !== null && Array.isArray((content as { sourceRefs?: unknown }).sourceRefs)
    ? (content as { sourceRefs: string[] }).sourceRefs : [];
  return { content, sourceRefs: [...new Set([snapshot.basis.documentVersionId, ...recapRefs])] };
}

function terminalOutcome(reviewId: string): SummaryReviewOutcome {
  const review = readReviewById(reviewId);
  if (!review) throw new SummaryReviewError('Summary review not found', 404);
  const replay = replayFromRow(review);
  if (!replay.outcome) throw new SummaryReviewError(`Summary review is already ${review.status}`, 409);
  return replay.outcome;
}

export function finalizeSummaryReview(input: { reviewId: string; result: unknown; modelId: string; visualImage?: unknown }): SummaryReviewOutcome {
  const existing = readReviewById(input.reviewId);
  if (!existing) throw new SummaryReviewError('Summary review not found', 404);
  if (existing.status !== 'pending') return terminalOutcome(input.reviewId);
  const parsedResult = parseSummaryReviewToolInput(input.result);
  db.exec('BEGIN IMMEDIATE');
  try {
    const review = readReviewById(input.reviewId);
    if (!review) throw new SummaryReviewError('Summary review not found', 404);
    if (review.status !== 'pending') { db.exec('ROLLBACK'); return terminalOutcome(input.reviewId); }
    const snapshot = parseAuditedSnapshot(review.snapshot_json), replacement = replacementFor(snapshot, parsedResult, input.visualImage);
    const artifact = row<StoredSummaryArtifact>(`SELECT a.*,v.document_id artifact_document_id
      FROM artifacts a JOIN document_versions v ON v.id=a.document_version_id WHERE a.id=?`, snapshot.artifactId);
    const latest = row<{ id: string }>('SELECT id FROM document_versions WHERE document_id=? ORDER BY version DESC LIMIT 1', snapshot.documentId);
    const currentBasis = latest ? summaryBasis(latest.id) : undefined;
    const artifactChanged = !artifact || artifact.version !== snapshot.artifactVersion;
    const basisChanged = !currentBasis || !sameBasis(currentBasis, snapshot.basis);
    if (artifactChanged || basisChanged) {
      const reason: SummaryReviewOutcome['supersededReason'] = artifactChanged ? 'artifact-changed' : 'basis-changed';
      const outcome: SummaryReviewOutcome = {
        reviewId: review.id,
        artifactId: snapshot.artifactId,
        artifactVersion: artifact?.version ?? snapshot.artifactVersion,
        decision: parsedResult.decision,
        applied: false,
        rationale: parsedResult.rationale,
        sourceStatus: parsedResult.sourceStatus,
        basis: snapshot.basis,
        freshness: artifact && currentBasis ? summaryFreshness(artifact, currentBasis) : { status: 'unknown', reasons: ['missing-basis'] },
        supersededReason: reason,
      };
      db.prepare("UPDATE summary_reviews SET decision=?,result_json=?,status='superseded' WHERE id=? AND status='pending'").run(parsedResult.decision, JSON.stringify({ outcome, result: parsedResult }), review.id);
      db.exec('COMMIT');
      return outcome;
    }

    const time = now(), nextVersion = snapshot.artifactVersion + 1;
    let changed = 0;
    if (parsedResult.decision === 'KEEP') {
      changed = Number(db.prepare(`UPDATE artifacts SET document_version_id=?,version=?,basis_document_version_id=?,basis_revision=?,basis_signal_hash=?
        WHERE id=? AND version=?`).run(snapshot.basis.documentVersionId, nextVersion, snapshot.basis.documentVersionId, snapshot.basis.revision, snapshot.basis.signalHash, snapshot.artifactId, snapshot.artifactVersion).changes);
    } else {
      changed = Number(db.prepare(`UPDATE artifacts SET document_version_id=?,version=?,content_json=?,source_refs_json=?,basis_document_version_id=?,basis_revision=?,basis_signal_hash=?,created_at=?
        WHERE id=? AND version=?`).run(snapshot.basis.documentVersionId, nextVersion, JSON.stringify(replacement!.content), JSON.stringify(replacement!.sourceRefs), snapshot.basis.documentVersionId, snapshot.basis.revision, snapshot.basis.signalHash, time, snapshot.artifactId, snapshot.artifactVersion).changes);
      if (changed) {
        db.prepare("DELETE FROM search_index WHERE kind='artifact' AND entity_id=?").run(snapshot.artifactId);
        db.prepare(`INSERT INTO search_index(kind,entity_id,document_id,title,body,tags,model_id,created_at) VALUES(?,?,?,?,?,?,?,?)`).run('artifact', snapshot.artifactId, snapshot.documentId, snapshot.artifactKind, typeof replacement!.content === 'string' ? replacement!.content : JSON.stringify(replacement!.content), '', input.modelId, time);
      }
    }
    if (!changed) throw new SummaryReviewError('Summary artifact changed while applying review', 409);
    const outcome: SummaryReviewOutcome = {
      reviewId: review.id,
      artifactId: snapshot.artifactId,
      artifactVersion: nextVersion,
      decision: parsedResult.decision,
      applied: true,
      rationale: parsedResult.rationale,
      sourceStatus: parsedResult.sourceStatus,
      basis: snapshot.basis,
      freshness: { status: 'current', reasons: [] },
    };
    db.prepare("UPDATE summary_reviews SET decision=?,result_json=?,status='applied',applied_at=? WHERE id=? AND status='pending'").run(parsedResult.decision, JSON.stringify({ outcome, result: parsedResult }), time, review.id);
    db.exec('COMMIT');
    return outcome;
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* transaction already closed */ }
    throw error;
  }
}

export function latestSummaryReview(artifactId: string): LatestSummaryReview | undefined {
  const review = row<StoredReview>(`SELECT sr.*,COALESCE(mr.fallback_model_id,mr.model_id) model_id FROM summary_reviews sr
    JOIN model_runs mr ON mr.id=sr.model_run_id WHERE sr.artifact_id=? ORDER BY sr.created_at DESC LIMIT 1`, artifactId);
  if (!review) return;
  const replay = replayFromRow(review);
  return {
    id: review.id,
    status: review.status,
    decision: review.decision,
    rationale: replay.outcome?.rationale ?? null,
    sourceStatus: replay.outcome?.sourceStatus ?? null,
    modelId: review.model_id ?? null,
    artifactVersion: replay.outcome?.artifactVersion ?? review.artifact_version,
    basis: { documentVersionId: review.document_version_id, revision: review.basis_revision, signalHash: review.basis_signal_hash },
    createdAt: review.created_at,
    appliedAt: review.applied_at,
  };
}
