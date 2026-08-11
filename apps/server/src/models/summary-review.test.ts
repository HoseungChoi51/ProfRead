import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { db, now, row } from '../db/index.js';
import { importSource } from '../ingest/index.js';
import {
  failSummaryReview,
  finalizeSummaryReview,
  formatSummaryReviewInput,
  latestSummaryReview,
  parseSummaryReviewToolInput,
  prepareSummaryReview,
  replaySummaryReview,
  startSummaryReview,
  summaryBasis,
  summaryReviewTool,
  validateSummaryArtifactContent,
  type SummaryArtifactKind,
} from './summary-review.js';

function expectStrictProviderSchema(schema:unknown,root=true):void{
  expect(schema).toBeTypeOf('object');
  const value=schema as Record<string,unknown>;
  expect(value).not.toHaveProperty('$schema');
  expect(value).not.toHaveProperty('oneOf');
  expect(value).not.toHaveProperty('minLength');
  expect(value).not.toHaveProperty('maxLength');
  if(root){expect(value.type).toBe('object');expect(value).not.toHaveProperty('anyOf')}
  if(value.type==='object'){
    const properties=value.properties as Record<string,unknown>;
    expect(value.additionalProperties).toBe(false);
    expect(new Set(value.required as string[])).toEqual(new Set(Object.keys(properties)));
    for(const property of Object.values(properties))expectStrictProviderSchema(property,false);
  }
  if(Array.isArray(value.anyOf))for(const option of value.anyOf)expectStrictProviderSchema(option,false);
  if(value.items&&typeof value.items==='object')expectStrictProviderSchema(value.items,false);
}

type Fixture = {
  documentId: string;
  versionId: string;
  block: { id: string; text_content: string; start_offset: number; end_offset: number };
};

async function documentFixture(label: string): Promise<Fixture> {
  const marker = randomUUID(), imported = await importSource({
    buffer: Buffer.from(`<title>${label} ${marker}</title><p>Complete article body ${marker}</p>`),
    filename: `${label}-${marker}.html`,
    mimeType: 'text/html',
  });
  if (!imported.documentId || !imported.versionId) throw new Error('Summary review fixture import failed');
  const block = row<Fixture['block']>('SELECT id,text_content,start_offset,end_offset FROM blocks WHERE document_version_id=? AND block_type=\'text\' ORDER BY ordinal DESC LIMIT 1', imported.versionId)!;
  return { documentId: imported.documentId, versionId: imported.versionId, block };
}

function addSignal(fixture: Fixture, kind: 'important' | 'comment' = 'important', note: string | null = null): string {
  const anchorId = randomUUID(), signalId = randomUUID(), time = now();
  db.prepare(`INSERT INTO anchors(id,document_version_id,block_id,exact_quote,prefix_text,suffix_text,start_offset,end_offset,block_type,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?)`).run(anchorId, fixture.versionId, fixture.block.id, fixture.block.text_content, '', '', fixture.block.start_offset, fixture.block.end_offset, 'text', time);
  db.prepare('INSERT INTO highlights(id,anchor_id,checked,color,kind,note,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)').run(signalId, anchorId, 1, kind === 'comment' ? 'pink' : 'yellow', kind, note, time, time);
  return signalId;
}

function artifactContent(kind: SummaryArtifactKind): unknown {
  if (kind !== 'visual-recap') return kind === 'half-page' ? Array.from({ length: 320 }, () => 'word').join(' ') : '- Existing summary';
  return {
    version: 1,
    title: 'Existing recap',
    thesis: 'Existing thesis',
    sections: [],
    relationships: [],
    takeaways: ['Existing takeaway'],
    openQuestions: [],
    sourceRefs: [],
    image: { url: '/api/generated/old-image.png', alt: 'Existing visual recap', modelId: 'old-model' },
  };
}

function addArtifact(fixture: Fixture, kind: SummaryArtifactKind = 'tldr', promoted = true): { id: string; basis: ReturnType<typeof summaryBasis>; content: unknown } {
  const id = randomUUID(), basis = summaryBasis(fixture.versionId), content = artifactContent(kind), time = now();
  db.prepare(`INSERT INTO artifacts(id,document_version_id,kind,version,scope_type,scope_id,content_json,source_refs_json,promoted,basis_document_version_id,basis_revision,basis_signal_hash,created_at)
    VALUES(?,?,?,1,'document',?,?,?,?,?,?,?,?)`).run(id, fixture.versionId, kind, fixture.documentId, JSON.stringify(content), JSON.stringify([fixture.versionId]), promoted ? 1 : 0, basis.documentVersionId, basis.revision, basis.signalHash, time);
  db.prepare('INSERT INTO search_index(kind,entity_id,document_id,title,body,tags,model_id,created_at) VALUES(?,?,?,?,?,?,?,?)').run('artifact', id, fixture.documentId, kind, typeof content === 'string' ? content : JSON.stringify(content), '', 'old-model', time);
  return { id, basis, content };
}

function addModelRun(): string {
  const id = randomUUID();
  db.prepare(`INSERT INTO model_runs(id,request_id,action,profile,routing_reason,context_tier,status,created_at)
    VALUES(?,?,'review-summary','digest','test review','canonical','running',?)`).run(id, randomUUID(), now());
  return id;
}

afterAll(() => {
  // The normal test data directory is disposable; individual rows use random IDs.
});

describe('semantic summary review foundation', () => {
  it('exposes an OpenAI strict-compatible tool schema and normalizes its required nulls before semantic validation', () => {
    expectStrictProviderSchema(summaryReviewTool.schema);
    const parsed=parseSummaryReviewToolInput({
      decision:'KEEP',rationale:'The summary remains sufficient.',sourceStatus:'adequate',
      signalCoverage:[{signalId:'signal-1',status:'covered',explanation:null}],replacement:null,
    });
    expect(parsed).toEqual({decision:'KEEP',rationale:'The summary remains sufficient.',sourceStatus:'adequate',signalCoverage:[{signalId:'signal-1',status:'covered'}]});
  });

  it('counts CJK characters as summary length units',()=>{
    expect(validateSummaryArtifactContent('half-page','가'.repeat(320))).toBe('가'.repeat(320));
    expect(()=>validateSummaryArtifactContent('half-page','가'.repeat(299))).toThrow('300 to 450');
    expect(()=>validateSummaryArtifactContent('half-page','가'.repeat(451))).toThrow('300 to 450');
  });

  it('allows at most five unordered or ordered Markdown TL;DR bullets',()=>{
    const unorderedFive=Array.from({length:5},(_,index)=>`+ Point ${index+1}`).join('\n');
    const unorderedSix=Array.from({length:6},(_,index)=>`+ Point ${index+1}`).join('\n');
    const orderedFive=Array.from({length:5},(_,index)=>`${index+1}${index%2?')':'.'} Point ${index+1}`).join('\n');
    const orderedSix=Array.from({length:6},(_,index)=>`${index+1}${index%2?')':'.'} Point ${index+1}`).join('\n');
    expect(validateSummaryArtifactContent('tldr',unorderedFive)).toBe(unorderedFive);
    expect(()=>validateSummaryArtifactContent('tldr',unorderedSix)).toThrow('at most five bullets');
    expect(validateSummaryArtifactContent('tldr',orderedFive)).toBe(orderedFive);
    expect(()=>validateSummaryArtifactContent('tldr',orderedSix)).toThrow('at most five bullets');
  });

  it('validates the latest document-scoped stale summary before any provider work', async () => {
    const fixture = await documentFixture('review-input'), artifact = addArtifact(fixture);
    expect(() => prepareSummaryReview({ artifactId: artifact.id, expectedArtifactVersion: 1, documentId: fixture.documentId, documentVersionId: fixture.versionId })).toThrow('already current');

    const signalId = addSignal(fixture);
    const snapshot = prepareSummaryReview({ artifactId: artifact.id, expectedArtifactVersion: 1, documentId: fixture.documentId, documentVersionId: fixture.versionId });
    expect(snapshot).toMatchObject({ artifactId: artifact.id, artifactVersion: 1, artifactKind: 'tldr', freshness: { status: 'needs-review', reasons: ['reader-signals-changed'] } });
    expect(snapshot.article).toContain('Complete article body');
    expect(snapshot.signals).toEqual([{ id: signalId, kind: 'important', exactQuote: fixture.block.text_content, note: null }]);
    const formatted = formatSummaryReviewInput(snapshot);
    expect(formatted).toContain(snapshot.article);
    expect(formatted).toContain(JSON.stringify(snapshot.artifactContent));
    expect(formatted).toContain(JSON.stringify(snapshot.signals));
    expect(formatted).toContain('Call review_summary exactly once');
    expect(summaryReviewTool.name).toBe('review_summary');
    expect(JSON.stringify(summaryReviewTool.schema)).toContain('"decision"');

    expect(() => prepareSummaryReview({ artifactId: artifact.id, expectedArtifactVersion: 2, documentId: fixture.documentId, documentVersionId: fixture.versionId })).toThrow('changed');
    expect(() => prepareSummaryReview({ artifactId: artifact.id, expectedArtifactVersion: 1, documentId: fixture.documentId, documentVersionId: randomUUID() })).toThrow('latest document version');
    const other = await documentFixture('review-cross-document');
    expect(() => prepareSummaryReview({ artifactId: artifact.id, expectedArtifactVersion: 1, documentId: other.documentId, documentVersionId: other.versionId })).toThrow('supplied document');

    const compactId = randomUUID(), time = now();
    db.prepare(`INSERT INTO artifacts(id,document_version_id,kind,version,scope_type,scope_id,content_json,source_refs_json,promoted,created_at)
      VALUES(?,?, 'compact',1,'document',?,?,?,0,?)`).run(compactId, fixture.versionId, fixture.documentId, JSON.stringify('Compact'), JSON.stringify([fixture.versionId]), time);
    expect(() => prepareSummaryReview({ artifactId: compactId, expectedArtifactVersion: 1, documentId: fixture.documentId, documentVersionId: fixture.versionId })).toThrow('does not support');
  });

  it('applies KEEP by advancing only basis and artifact version and replays idempotently', async () => {
    const fixture = await documentFixture('review-keep'), artifact = addArtifact(fixture), signalId = addSignal(fixture);
    const snapshot = prepareSummaryReview({ artifactId: artifact.id, expectedArtifactVersion: 1, documentId: fixture.documentId, documentVersionId: fixture.versionId });
    const runId=addModelRun();db.prepare('UPDATE model_runs SET model_id=?,fallback_model_id=? WHERE id=?').run('initial-model','fallback-model',runId);const started = startSummaryReview(runId, snapshot);
    expect(started).toMatchObject({ status: 'pending', snapshot: { articleHash: snapshot.articleHash, artifactContent: artifact.content } });
    expect((started.snapshot as Record<string, unknown>).article).toBeUndefined();

    const result = { decision: 'KEEP', rationale: 'The important passage is already represented.', sourceStatus: 'adequate', signalCoverage: [{ signalId, status: 'covered' }] };
    const outcome = finalizeSummaryReview({ reviewId: started.reviewId, result, modelId: 'review-model' });
    expect(outcome).toMatchObject({ decision: 'KEEP', sourceStatus: 'adequate', applied: true, artifactVersion: 2, freshness: { status: 'current', reasons: [] } });
    const stored = row<{ version: number; content_json: string; source_refs_json: string; promoted: number; basis_signal_hash: string }>('SELECT version,content_json,source_refs_json,promoted,basis_signal_hash FROM artifacts WHERE id=?', artifact.id)!;
    expect(stored).toMatchObject({ version: 2, content_json: JSON.stringify(artifact.content), source_refs_json: JSON.stringify([fixture.versionId]), promoted: 1, basis_signal_hash: snapshot.basis.signalHash });
    expect(row<{ body: string; model_id: string }>("SELECT body,model_id FROM search_index WHERE kind='artifact' AND entity_id=?", artifact.id)).toEqual({ body: artifact.content, model_id: 'old-model' });
    expect(replaySummaryReview(started.modelRunId)).toMatchObject({ status: 'applied', outcome });
    expect(latestSummaryReview(artifact.id)).toMatchObject({ status: 'applied', decision: 'KEEP', rationale: result.rationale, sourceStatus: 'adequate', artifactVersion: 2,modelId:'fallback-model' });
    expect(finalizeSummaryReview({ reviewId: started.reviewId, result: { malformed: true }, modelId: 'review-model' })).toEqual(outcome);
  });

  it('reviews a legacy generated text summary while keeping replacement validation strict',async()=>{
    const fixture=await documentFixture('review-legacy-half-page'),artifact=addArtifact(fixture,'half-page');
    db.prepare('UPDATE artifacts SET content_json=? WHERE id=?').run(JSON.stringify('A generated half-page that predates strict length validation.'),artifact.id);
    const signalId=addSignal(fixture),snapshot=prepareSummaryReview({artifactId:artifact.id,expectedArtifactVersion:1,documentId:fixture.documentId,documentVersionId:fixture.versionId});
    expect(snapshot.artifactContent).toBe('A generated half-page that predates strict length validation.');
    const review=startSummaryReview(addModelRun(),snapshot),base={decision:'REPLACE',rationale:'The Important signal is missing.',sourceStatus:'adequate',signalCoverage:[{signalId,status:'missing'}]} as const;
    expect(()=>finalizeSummaryReview({reviewId:review.reviewId,result:{...base,replacement:{kind:'half-page',content:'Still too short.'}},modelId:'review-model'})).toThrow('300 to 450');
    const replacement='나'.repeat(320),outcome=finalizeSummaryReview({reviewId:review.reviewId,result:{...base,replacement:{kind:'half-page',content:replacement}},modelId:'review-model'});
    expect(outcome).toMatchObject({applied:true,decision:'REPLACE'});
    expect(row<{content_json:string}>('SELECT content_json FROM artifacts WHERE id=?',artifact.id)?.content_json).toBe(JSON.stringify(replacement));
  });

  it('validates and atomically applies a typed REPLACE while preserving the pin', async () => {
    const fixture = await documentFixture('review-replace'), artifact = addArtifact(fixture), signalId = addSignal(fixture);
    const snapshot = prepareSummaryReview({ artifactId: artifact.id, expectedArtifactVersion: 1, documentId: fixture.documentId, documentVersionId: fixture.versionId });
    const started = startSummaryReview(addModelRun(), snapshot);
    const unknownCoverage = { decision: 'REPLACE', rationale: 'Missing the highlighted claim.', sourceStatus: 'adequate', signalCoverage: [{ signalId: randomUUID(), status: 'missing' }], replacement: { kind: 'tldr', content: '- Revised summary' } };
    expect(() => finalizeSummaryReview({ reviewId: started.reviewId, result: unknownCoverage, modelId: 'review-model' })).toThrow('unknown signal');
    const omittedCoverage = { decision: 'REPLACE', rationale: 'The article itself changed.', sourceStatus: 'material-gap', signalCoverage: [], replacement: { kind: 'tldr', content: '- Revised summary' } };
    expect(() => finalizeSummaryReview({ reviewId: started.reviewId, result: omittedCoverage, modelId: 'review-model' })).toThrow('omitted signal');
    expect(row<{ status: string; version: number }>('SELECT sr.status,a.version FROM summary_reviews sr JOIN artifacts a ON a.id=sr.artifact_id WHERE sr.id=?', started.reviewId)).toEqual({ status: 'pending', version: 1 });

    const result = { decision: 'REPLACE', rationale: 'Missing the highlighted claim.', sourceStatus: 'adequate', signalCoverage: [{ signalId, status: 'missing' }], replacement: { kind: 'tldr', content: '- Revised summary' } };
    const outcome = finalizeSummaryReview({ reviewId: started.reviewId, result, modelId: 'review-model' });
    expect(outcome).toMatchObject({ decision: 'REPLACE', applied: true, artifactVersion: 2 });
    expect(row<{ version: number; content_json: string; source_refs_json: string; promoted: number }>('SELECT version,content_json,source_refs_json,promoted FROM artifacts WHERE id=?', artifact.id)).toEqual({ version: 2, content_json: JSON.stringify('- Revised summary'), source_refs_json: JSON.stringify([fixture.versionId]), promoted: 1 });
    expect(row<{ body: string; model_id: string }>("SELECT body,model_id FROM search_index WHERE kind='artifact' AND entity_id=?", artifact.id)).toEqual({ body: '- Revised summary', model_id: 'review-model' });
    const audit = JSON.parse(row<{ result_json: string }>('SELECT result_json FROM summary_reviews WHERE id=?', started.reviewId)!.result_json);
    expect(audit).toMatchObject({ outcome: { applied: true }, result: { signalCoverage: [{ signalId, status: 'missing' }] } });
  });

  it('reviews the complete effective article and can replace for a material source edit with no reader signals', async () => {
    const fixture = await documentFixture('review-source-edit'), artifact = addArtifact(fixture), revisedArticle = `Complete revised article ${randomUUID()}`;
    db.prepare(`INSERT INTO document_edit_revisions(id,document_version_id,revision,edited_html_path,canonical_text,base_title,summary_json,restored_from_revision,created_at)
      VALUES(?,?,?,?,?,?,?,?,?)`).run(randomUUID(), fixture.versionId, 1, `/tmp/${randomUUID()}.html`, revisedArticle, 'Revised article', '{}', null, now());
    const snapshot = prepareSummaryReview({ artifactId: artifact.id, expectedArtifactVersion: 1, documentId: fixture.documentId, documentVersionId: fixture.versionId });
    expect(snapshot).toMatchObject({ article: revisedArticle, signals: [], freshness: { status: 'needs-review', reasons: ['document-edits-changed'] } });
    const review = startSummaryReview(addModelRun(), snapshot);
    const outcome = finalizeSummaryReview({
      reviewId: review.reviewId,
      result: { decision: 'REPLACE', rationale: 'The edited source materially changes the conclusion.', sourceStatus: 'material-gap', signalCoverage: [], replacement: { kind: 'tldr', content: '- Summary of the revised conclusion' } },
      modelId: 'review-model',
    });
    expect(outcome).toMatchObject({ decision: 'REPLACE', sourceStatus: 'material-gap', applied: true, artifactVersion: 2 });
    expect(row<{ content_json: string }>('SELECT content_json FROM artifacts WHERE id=?', artifact.id)?.content_json).toBe(JSON.stringify('- Summary of the revised conclusion'));
  });

  it('persists a superseded verdict and applies nothing when the exact basis races', async () => {
    const fixture = await documentFixture('review-basis-race'), artifact = addArtifact(fixture), signalId = addSignal(fixture);
    const snapshot = prepareSummaryReview({ artifactId: artifact.id, expectedArtifactVersion: 1, documentId: fixture.documentId, documentVersionId: fixture.versionId });
    const started = startSummaryReview(addModelRun(), snapshot);
    addSignal(fixture, 'comment', 'New reader instruction during review');
    const result = { decision: 'KEEP', rationale: 'The original signal was covered.', sourceStatus: 'adequate', signalCoverage: [{ signalId, status: 'covered' }] };
    const outcome = finalizeSummaryReview({ reviewId: started.reviewId, result, modelId: 'review-model' });
    expect(outcome).toMatchObject({ applied: false, supersededReason: 'basis-changed', artifactVersion: 1 });
    expect(row<{ version: number; content_json: string }>('SELECT version,content_json FROM artifacts WHERE id=?', artifact.id)).toEqual({ version: 1, content_json: JSON.stringify(artifact.content) });
    expect(replaySummaryReview(started.modelRunId)).toMatchObject({ status: 'superseded', outcome });
  });

  it('supersedes an artifact-version race and never overwrites the competing summary', async () => {
    const fixture = await documentFixture('review-artifact-race'), artifact = addArtifact(fixture), signalId = addSignal(fixture);
    const snapshot = prepareSummaryReview({ artifactId: artifact.id, expectedArtifactVersion: 1, documentId: fixture.documentId, documentVersionId: fixture.versionId });
    const started = startSummaryReview(addModelRun(), snapshot);
    db.prepare('UPDATE artifacts SET version=2,content_json=? WHERE id=? AND version=1').run(JSON.stringify('- Competing summary'), artifact.id);
    const result = { decision: 'REPLACE', rationale: 'Would replace the old summary.', sourceStatus: 'adequate', signalCoverage: [{ signalId, status: 'missing' }], replacement: { kind: 'tldr', content: '- Review replacement' } };
    const outcome = finalizeSummaryReview({ reviewId: started.reviewId, result, modelId: 'review-model' });
    expect(outcome).toMatchObject({ applied: false, supersededReason: 'artifact-changed', artifactVersion: 2 });
    expect(row<{ content_json: string }>('SELECT content_json FROM artifacts WHERE id=?', artifact.id)?.content_json).toBe(JSON.stringify('- Competing summary'));
  });

  it('preserves a visual image on KEEP and accepts a supplied candidate only on applied REPLACE', async () => {
    const keptFixture = await documentFixture('review-visual-keep'), keptArtifact = addArtifact(keptFixture, 'visual-recap'), keptSignal = addSignal(keptFixture);
    const keptSnapshot = prepareSummaryReview({ artifactId: keptArtifact.id, expectedArtifactVersion: 1, documentId: keptFixture.documentId, documentVersionId: keptFixture.versionId });
    const keptReview = startSummaryReview(addModelRun(), keptSnapshot);
    finalizeSummaryReview({ reviewId: keptReview.reviewId, result: { decision: 'KEEP', rationale: 'Recap already covers it.', sourceStatus: 'adequate', signalCoverage: [{ signalId: keptSignal, status: 'covered' }] }, modelId: 'review-model' });
    expect(JSON.parse(row<{ content_json: string }>('SELECT content_json FROM artifacts WHERE id=?', keptArtifact.id)!.content_json).image.url).toBe('/api/generated/old-image.png');

    const fixture = await documentFixture('review-visual-replace'), artifact = addArtifact(fixture, 'visual-recap'), signalId = addSignal(fixture);
    const snapshot = prepareSummaryReview({ artifactId: artifact.id, expectedArtifactVersion: 1, documentId: fixture.documentId, documentVersionId: fixture.versionId });
    const review = startSummaryReview(addModelRun(), snapshot), recap = { version: 1, title: 'New recap', thesis: 'New thesis', sections: [], relationships: [], takeaways: [], openQuestions: [], sourceRefs: [] };
    const result = { decision: 'REPLACE', rationale: 'Visual omitted the important claim.', sourceStatus: 'adequate', signalCoverage: [{ signalId, status: 'missing' }], replacement: { kind: 'visual-recap', content: recap } };
    expect(() => finalizeSummaryReview({ reviewId: review.reviewId, result, modelId: 'review-model' })).toThrow('requires a generated image');
    expect(row<{ status: string }>('SELECT status FROM summary_reviews WHERE id=?', review.reviewId)?.status).toBe('pending');
    finalizeSummaryReview({
      reviewId: review.reviewId,
      result,
      modelId: 'review-model',
      visualImage: { url: '/api/generated/new-image.png', alt: 'New visual recap', modelId: 'image-model' },
    });
    expect(JSON.parse(row<{ content_json: string }>('SELECT content_json FROM artifacts WHERE id=?', artifact.id)!.content_json)).toMatchObject({ title: 'New recap', image: { url: '/api/generated/new-image.png', modelId: 'image-model' } });
  });

  it('persists cancellation without changing the artifact', async () => {
    const fixture = await documentFixture('review-cancel'), artifact = addArtifact(fixture);
    addSignal(fixture);
    const snapshot = prepareSummaryReview({ artifactId: artifact.id, expectedArtifactVersion: 1, documentId: fixture.documentId, documentVersionId: fixture.versionId });
    const review = startSummaryReview(addModelRun(), snapshot), cancelled = failSummaryReview(review.reviewId, 'Cancelled', 'cancelled');
    expect(cancelled).toMatchObject({ status: 'cancelled', error: 'Cancelled' });
    expect(row<{ version: number; content_json: string }>('SELECT version,content_json FROM artifacts WHERE id=?', artifact.id)).toEqual({ version: 1, content_json: JSON.stringify(artifact.content) });
  });
});
