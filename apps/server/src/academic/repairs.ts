import {
  importRepairProposalSchema,
  type DocumentEditOperation,
  type ImportAuditReport,
  type ImportRepairProposal,
} from '@profread/shared';
import { db, now, row, rows } from '../db/index.js';

type Finding = ImportAuditReport['findings'][number];
type FindingDecision = 'accepted'|'dismissed'|'manual';
type StoredFinding = {
  id: string;
  source: string;
  confidence: string|null;
  target_ref: string|null;
  repair_json: string|null;
  corroborated: number;
  decision: string;
  applied_at: string|null;
};

type RenderMetric = {
  blockId?: string;
  tag?: string;
  visible?: boolean;
  clippedX?: boolean;
  clippedY?: boolean;
  clientWidth?: number;
  scrollWidth?: number;
  clientHeight?: number;
  scrollHeight?: number;
  overflowX?: string;
  overflowY?: string;
  rect?: { x?: number; width?: number };
  viewportWidth?: number;
};

const safeTags = new Set(['figure','img','svg','table','video']);

function asArray(value: unknown): any[] { return Array.isArray(value) ? value : []; }
function numeric(value: unknown): number { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : 0; }

function metricsByBlock(manifest: Record<string,unknown>): Map<string,RenderMetric[]> {
  const result = new Map<string,RenderMetric[]>();
  for (const view of asArray(manifest.views)) {
    const viewportWidth = numeric(view?.viewport?.width);
    for (const raw of asArray(view?.objects)) {
      const blockId = typeof raw?.blockId === 'string' ? raw.blockId : '';
      if (!blockId) continue;
      const metric: RenderMetric = { ...raw, viewportWidth };
      const existing = result.get(blockId) ?? [];
      existing.push(metric);
      result.set(blockId, existing);
    }
  }
  return result;
}

function overflows(metric: RenderMetric): boolean {
  if (metric.visible === false) return false;
  const x = numeric(metric.rect?.x), width = numeric(metric.rect?.width), viewport = numeric(metric.viewportWidth);
  const overflowX=metric.overflowX??'visible',overflowY=metric.overflowY??'visible',intentionalX=/^(?:auto|scroll)$/i.test(overflowX),intentionalY=/^(?:auto|scroll)$/i.test(overflowY),
    horizontalClip=!intentionalX&&(/^(?:hidden|clip)$/i.test(overflowX)&&(Boolean(metric.clippedX)||numeric(metric.scrollWidth)>numeric(metric.clientWidth)+1)||(overflowX==='visible'||!overflowX)&&(viewport>0&&(width>viewport+1||x< -1||x+width>viewport+1))),
    verticalClip=!intentionalY&&/^(?:hidden|clip)$/i.test(overflowY)&&(Boolean(metric.clippedY)||numeric(metric.scrollHeight)>numeric(metric.clientHeight)+1);
  return horizontalClip||verticalClip;
}

function targetNode(html: string, targetRef: string): { tag:string; fixedDimensions:boolean; tableScroll:boolean }|null {
  const $ = loadProfreadHtml(html), node = $('[data-block-id]').filter((_index,element)=>$(element).attr('data-block-id')===targetRef).first();
  if (!node.length) return null;
  const tag = node.get(0)!.tagName.toLowerCase(),candidates=[node,...(tag==='figure'?node.find('img,svg,video,table').toArray().map(element=>$(element)):[])],fixedDimensions=candidates.some(candidate=>{const style=candidate.attr('style')??'';return Boolean(candidate.attr('width')||candidate.attr('height'))||/(?:^|;)\s*(?:width|height)\s*:\s*\d+(?:\.\d+)?(?:px|pt|pc|in|cm|mm)\s*(?:!important)?\s*(?:;|$)/i.test(style)});
  return { tag, fixedDimensions, tableScroll: node.closest('.profread-table-scroll').length > 0 };
}

/**
 * A model observation is corroborated only when the exact sanitized block is a
 * presentation object and Chromium measured clipping/overflow.
 * Scholarly text, MathML, citations, and table-cell contents never qualify.
 */
export function corroborateImportRepair(finding: Finding, renderManifest: Record<string,unknown>, previewHtml: string): boolean {
  const repair = finding.suggestedRepair;
  if (!repair || !finding.targetRefs.includes(repair.targetRef)) return false;
  if (!['set-object-layout','wrap-overflow','clear-fixed-dimensions'].includes(repair.type)) return false;
  const node = targetNode(previewHtml, repair.targetRef);
  if (!node || !safeTags.has(node.tag)) return false;
  const measurements = metricsByBlock(renderManifest).get(repair.targetRef) ?? [];
  if (!measurements.some(metric => metric.tag === node.tag && overflows(metric))) return false;
  if (repair.type === 'set-object-layout') return repair.width !== 'auto';
  // A table already inside the sanitizer's horizontal scroll host is readable;
  // its larger scrollWidth is intentional navigation, not corroborated crop.
  if (repair.type === 'wrap-overflow') return node.tag === 'table' && !node.tableScroll;
  return node.fixedDimensions;
}

export function importRepairOperation(repair: ImportRepairProposal): DocumentEditOperation|null {
  if (repair.type === 'set-object-layout' && repair.width !== 'auto') return {
    type:'set-object-layout', blockId:repair.targetRef, width:repair.width,
    alignment:repair.alignment, enlargeable:repair.enlargeable, folded:false,
  };
  if (repair.type === 'wrap-overflow') return {
    type:'set-object-layout', blockId:repair.targetRef, width:'full',
    alignment:'center', enlargeable:true, folded:false,
  };
  if (repair.type === 'clear-fixed-dimensions') return {
    type:'clear-fixed-dimensions', blockId:repair.targetRef,
  };
  if (repair.type === 'restore-svg-semantics') return { type:'restore-svg-semantics', blockId:repair.targetRef };
  return null;
}

export function automaticImportRepairDecision(finding: Finding, corroborated: boolean, autoApply: boolean): 'accepted'|'pending' {
  return autoApply && corroborated && finding.confidence === 'high' && finding.suggestedRepair && importRepairOperation(finding.suggestedRepair)
    ? 'accepted'
    : 'pending';
}

function storedRepair(item: StoredFinding): ImportRepairProposal|null {
  if (!item.repair_json) return null;
  try { return importRepairProposalSchema.parse(JSON.parse(item.repair_json)); }
  catch { return null; }
}

export function canAcceptAcademicImportFinding(item: StoredFinding): boolean {
  const repair = storedRepair(item);
  return item.source === 'model' && item.confidence === 'high' && Boolean(item.corroborated)
    && item.target_ref === repair?.targetRef && Boolean(repair && importRepairOperation(repair));
}

export function decideAcademicImportFinding(jobId: string, findingId: string, decision: FindingDecision): { ok:true;decision:FindingDecision } {
  const job = row<{status:string}>('SELECT status FROM import_jobs WHERE id=?',jobId);
  if (!job) throw Object.assign(new Error('Import job not found'),{statusCode:404});
  if (job.status !== 'review-ready') throw Object.assign(new Error('Findings can only be decided before publication'),{statusCode:409});
  const item = row<StoredFinding>('SELECT id,source,confidence,target_ref,repair_json,corroborated,decision,applied_at FROM import_findings WHERE id=? AND import_job_id=?',findingId,jobId);
  if (!item) throw Object.assign(new Error('Import finding not found'),{statusCode:404});
  if (item.applied_at) throw Object.assign(new Error('An applied repair decision cannot be changed'),{statusCode:409});
  if (item.decision === decision) return {ok:true,decision};
  if (item.decision !== 'pending') throw Object.assign(new Error('This finding already has a decision'),{statusCode:409});
  if (decision === 'accepted' && !canAcceptAcademicImportFinding(item)) throw Object.assign(new Error('Only high-confidence, deterministically corroborated presentation repairs can be accepted'),{statusCode:409});
  db.prepare('UPDATE import_findings SET decision=?,updated_at=? WHERE id=? AND import_job_id=? AND decision=\'pending\'').run(decision,now(),findingId,jobId);
  return {ok:true,decision};
}

export function acceptedAcademicRepairPlan(jobId: string): { operations:DocumentEditOperation[];findingIds:string[];signature:string } {
  const findings = rows<StoredFinding>(`SELECT id,source,confidence,target_ref,repair_json,corroborated,decision,applied_at
    FROM import_findings WHERE import_job_id=? AND decision='accepted' ORDER BY created_at,id`,jobId);
  const operations: DocumentEditOperation[] = [], findingIds: string[] = [], byTarget = new Map<string,string>();
  for (const item of findings) {
    if (item.applied_at) continue;
    if (!canAcceptAcademicImportFinding(item)) throw new Error(`Accepted import finding is not an applicable presentation repair: ${item.id}`);
    const operation = importRepairOperation(storedRepair(item)!)!, serialized = JSON.stringify(operation), previous = byTarget.get(operation.blockId);
    if (previous && previous !== serialized) throw new Error(`Accepted import repairs conflict for target ${operation.blockId}`);
    if (!previous) { byTarget.set(operation.blockId,serialized); operations.push(operation); }
    findingIds.push(item.id);
  }
  operations.sort((left,right)=>JSON.stringify(left).localeCompare(JSON.stringify(right)));
  return { operations, findingIds, signature:JSON.stringify(operations) };
}
import { loadProfreadHtml } from '../ingest/branding.js';
