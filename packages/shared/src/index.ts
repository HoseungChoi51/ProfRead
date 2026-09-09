import { z } from 'zod';

export const protocolSchema = z.enum(['openai-responses', 'chat-completions', 'openrouter']);
export const capabilitySchema = z.object({
  text: z.boolean().default(true), vision: z.boolean().default(false),
  structuredOutput: z.boolean().default(false), functionTools: z.boolean().default(false),
  providerWebSearch: z.boolean().default(false), reasoningControl: z.boolean().default(false),
  imageGeneration: z.boolean().default(false), streaming: z.boolean().default(true),
});
export const modelDefinitionSchema = z.object({
  id: z.string(), providerId: z.string(), label: z.string(), protocol: protocolSchema,
  contextWindow: z.number().int().positive(), maxOutput: z.number().int().positive(),
  capabilities: capabilitySchema, priority: z.number().int().default(100), enabled: z.boolean().default(true),
});
export type ModelDefinition = z.infer<typeof modelDefinitionSchema>;

export const profileNameSchema = z.enum(['quick', 'standard', 'deep', 'vision', 'research', 'digest']);
export const modelProfileSchema = z.object({ name: profileNameSchema, modelIds: z.array(z.string()).min(1) });
export type ModelProfile = z.infer<typeof modelProfileSchema>;

export const taskActionSchema = z.enum([
  'define','explain','eli14','ask','polish-note','visualize','research','summarize','tldr','half-page','visual-recap','compact','document-write','review-summary',
  'import-triage','import-semantic-audit','import-visual-audit','import-adjudicate','import-verify-repair','import-repair-plan',
]);
export type TaskAction = z.infer<typeof taskActionSchema>;
export const taskModelRouteSchema = z.object({ action: taskActionSchema, modelId: z.string().min(1) });
export type TaskModelRoute = z.infer<typeof taskModelRouteSchema>;

export const anchorSelectorSchema = z.object({
  blockId: z.string().min(1), exact: z.string(), prefix: z.string().default(''), suffix: z.string().default(''),
  startOffset: z.number().int().nonnegative(), endOffset: z.number().int().nonnegative(),
  blockType: z.enum(['text', 'image', 'svg', 'table', 'diagram', 'video']).default('text'),
});
export type AnchorSelector = z.infer<typeof anchorSelectorSchema>;

export const documentEditOperationSchema=z.discriminatedUnion('type',[
  z.object({type:z.literal('replace-text'),blockId:z.string().min(1),text:z.string().max(100_000)}),
  z.object({type:z.literal('insert-text-block'),blockId:z.string().min(1),position:z.enum(['before','after']),tag:z.enum(['p','h2','h3','h4','h5','h6','blockquote','pre']),text:z.string().min(1).max(100_000)}),
  z.object({type:z.literal('delete-text-block'),blockId:z.string().min(1)}),
  z.object({type:z.literal('format-text'),blockId:z.string().min(1),startOffset:z.number().int().nonnegative(),endOffset:z.number().int().nonnegative(),style:z.enum(['bold','italic','underline']),enabled:z.boolean()}),
  z.object({type:z.literal('fold-section'),blockId:z.string().min(1),folded:z.boolean()}),
  z.object({type:z.literal('set-caption'),blockId:z.string().min(1),label:z.string().trim().max(40),number:z.string().trim().max(20),caption:z.string().trim().max(2000)}),
  z.object({type:z.literal('resize-image'),blockId:z.string().min(1),width:z.number().int().min(48).max(4000)}),
  z.object({type:z.literal('set-alt-text'),blockId:z.string().min(1),text:z.string().trim().max(2000)}),
  z.object({type:z.literal('set-heading-level'),blockId:z.string().min(1),level:z.number().int().min(1).max(6)}),
  z.object({type:z.literal('set-object-layout'),blockId:z.string().min(1),width:z.enum(['auto','content','full']),alignment:z.enum(['left','center','right']),enlargeable:z.boolean(),folded:z.boolean()}),
  z.object({type:z.literal('clear-fixed-dimensions'),blockId:z.string().min(1)}),
  z.object({type:z.literal('restore-svg-semantics'),blockId:z.string().min(1)}),
  z.object({type:z.literal('move-object'),blockId:z.string().min(1),destinationBlockId:z.string().min(1),position:z.enum(['before','after'])}),
]);
export type DocumentEditOperation=z.infer<typeof documentEditOperationSchema>;

export const writerSourceTypeSchema=z.enum(['message','thread-annotation','artifact','highlight']);
export type WriterSourceType=z.infer<typeof writerSourceTypeSchema>;
export const writerSourceRefSchema=z.object({type:writerSourceTypeSchema,id:z.string().trim().min(1).max(256)});
export type WriterSourceRef=z.infer<typeof writerSourceRefSchema>;

export const writerTextTagSchema=z.enum(['p','h2','h3','h4','h5','h6','blockquote','pre']);
export type WriterTextTag=z.infer<typeof writerTextTagSchema>;
export const writerEditOperationSchema=z.discriminatedUnion('type',[
  z.object({type:z.literal('replace-text'),blockId:z.string().trim().min(1).max(256),text:z.string().max(100_000)}),
  z.object({type:z.literal('insert-text-block'),blockId:z.string().trim().min(1).max(256),position:z.enum(['before','after']),tag:writerTextTagSchema,text:z.string().trim().min(1).max(100_000)}),
  z.object({type:z.literal('delete-text-block'),blockId:z.string().trim().min(1).max(256)}),
]);
export type WriterEditOperation=z.infer<typeof writerEditOperationSchema>;
export const writerProposalChangeInputSchema=z.object({
  operation:writerEditOperationSchema,
  rationale:z.string().trim().min(1).max(2000),
  sourceKeys:z.array(z.string().trim().min(1).max(256)).max(50).default([]),
});
export type WriterProposalChangeInput=z.infer<typeof writerProposalChangeInputSchema>;
export const writerProposalToolInputSchema=z.object({
  version:z.literal(1),
  title:z.string().trim().min(1).max(160),
  summary:z.string().trim().min(1).max(2000),
  changes:z.array(writerProposalChangeInputSchema).min(1).max(200),
});
export type WriterProposalToolInput=z.infer<typeof writerProposalToolInputSchema>;
export const writerProposalToolName='propose_document_edits' as const;
export const writerProposalChangeSchema=writerProposalChangeInputSchema.extend({
  id:z.string().trim().min(1).max(256),
  beforeText:z.string().max(100_000).nullable(),
  beforeTag:z.string().trim().min(1).max(32).nullable(),
});
export type WriterProposalChange=z.infer<typeof writerProposalChangeSchema>;
export const writerProposalStatusSchema=z.enum(['draft','applied','dismissed','superseded']);
export const writerProposalResultSchema=z.object({
  id:z.string().trim().min(1),
  threadId:z.string().trim().min(1),
  modelRunId:z.string().trim().min(1),
  documentVersionId:z.string().trim().min(1),
  baseRevision:z.number().int().nonnegative(),
  baseHtmlHash:z.string().regex(/^[a-f0-9]{64}$/),
  sourceHash:z.string().regex(/^[a-f0-9]{64}$/),
  instruction:z.string().max(20_000),
  title:z.string().trim().min(1).max(160),
  summary:z.string().trim().min(1).max(2000),
  changes:z.array(writerProposalChangeSchema).min(1).max(200),
  status:writerProposalStatusSchema,
  appliedRevision:z.number().int().nonnegative().nullable(),
  appliedChangeIds:z.array(z.string().trim().min(1)).nullable(),
  createdAt:z.string(),
  updatedAt:z.string(),
  appliedAt:z.string().nullable(),
});
export type WriterProposalResult=z.infer<typeof writerProposalResultSchema>;

export const highlightKindSchema = z.enum(['important', 'question', 'comment']);
export type HighlightKind = z.infer<typeof highlightKindSchema>;
export const readerSignalSchema = z.object({
  id: z.string(), kind: highlightKindSchema, exactQuote: z.string(), note: z.string().nullable(),
});
export type ReaderSignal = z.infer<typeof readerSignalSchema>;

export const contextBundleSchema = z.object({
  tier: z.enum(['canonical', 'brief', 'study', 'study-with-branch-digest']),
  article: z.string(), anchor: z.string().optional(), neighboringBlock: z.string().optional(),
  branch: z.array(z.object({ role: z.enum(['user', 'assistant']), content: z.string() })).default([]),
  readerSignals: z.array(readerSignalSchema).default([]), curatedNotes: z.array(z.string()).default([]),
  tokenEstimate: z.number().int().nonnegative(),
});
export type ContextBundle = z.infer<typeof contextBundleSchema>;

export const citationSchema = z.object({ id: z.string(), title: z.string().optional(), url: z.string().url(), start: z.number().optional(), end: z.number().optional() });
export type Citation = z.infer<typeof citationSchema>;

export const diagramSpecSchema = z.object({
  version: z.literal(1), title: z.string().min(1).max(160),
  layout: z.enum(['flow', 'hierarchy', 'timeline', 'cause-effect', 'comparison']),
  nodes: z.array(z.object({ id: z.string().regex(/^[a-zA-Z0-9_-]+$/), label: z.string().max(240), detail: z.string().max(600).optional(), sourceRefs: z.array(z.string()).default([]) })).max(24),
  edges: z.array(z.object({ from: z.string(), to: z.string(), label: z.string().max(120).optional() })).max(40),
});
export type DiagramSpec = z.infer<typeof diagramSpecSchema>;

export const visualRecapSchema = z.object({
  version: z.literal(1), title: z.string().max(160), thesis: z.string().max(800),
  sections: z.array(z.object({ title: z.string().max(120), summary: z.string().max(1000), sourceRefs: z.array(z.string().max(200)).max(12) })).max(6),
  relationships: z.array(z.object({ from: z.string().max(120), to: z.string().max(120), relation: z.string().max(240) })).max(20),
  takeaways: z.array(z.string().max(500)).max(12), openQuestions: z.array(z.string().max(500)).max(12), sourceRefs: z.array(z.string().max(200)).max(40),
  image: z.object({ url: z.string().regex(/^\/api\/generated\/[A-Za-z0-9_-]+\.png$/), alt: z.string().min(1).max(500), modelId: z.string().min(1) }).optional(),
});
export const visualRecapWithoutImageSchema=visualRecapSchema.omit({image:true}).strict();

export const summaryBasisSchema=z.object({
  documentVersionId:z.string().trim().min(1),
  revision:z.number().int().nonnegative(),
  signalHash:z.string().regex(/^[a-f0-9]{64}$/),
});
export type SummaryBasis=z.infer<typeof summaryBasisSchema>;
export const summaryFreshnessReasonSchema=z.enum(['document-version-changed','document-edits-changed','reader-signals-changed','missing-basis']);
export const summaryFreshnessSchema=z.object({
  status:z.enum(['current','needs-review','unknown']),
  reasons:z.array(summaryFreshnessReasonSchema),
});
export type SummaryFreshness=z.infer<typeof summaryFreshnessSchema>;
export const summaryReviewReplacementSchema=z.discriminatedUnion('kind',[
  z.object({kind:z.literal('tldr'),content:z.string().trim().min(1).max(20_000)}),
  z.object({kind:z.literal('half-page'),content:z.string().trim().min(1).max(50_000)}),
  z.object({kind:z.literal('visual-recap'),content:visualRecapWithoutImageSchema}),
]);
export const summarySignalCoverageSchema=z.object({signalId:z.string().trim().min(1).max(256),status:z.enum(['covered','missing','contradicted']),explanation:z.string().trim().min(1).max(2000).optional()});
export type SummarySignalCoverage=z.infer<typeof summarySignalCoverageSchema>;
const summarySignalCoverageListSchema=z.array(summarySignalCoverageSchema).max(200);
export const summarySourceStatusSchema=z.enum(['adequate','material-gap','contradiction']);
export type SummarySourceStatus=z.infer<typeof summarySourceStatusSchema>;
const summaryReviewKeepSchema=z.object({decision:z.literal('KEEP'),rationale:z.string().trim().min(1).max(4000),sourceStatus:summarySourceStatusSchema,signalCoverage:summarySignalCoverageListSchema}).strict().superRefine((value,context)=>{if(value.sourceStatus!=='adequate')context.addIssue({code:'custom',message:'KEEP requires an adequate source review',path:['sourceStatus']});if(value.signalCoverage.some(signal=>signal.status!=='covered'))context.addIssue({code:'custom',message:'KEEP requires every reviewed signal to be covered',path:['signalCoverage']})});
const summaryReviewReplaceSchema=z.object({decision:z.literal('REPLACE'),rationale:z.string().trim().min(1).max(4000),sourceStatus:summarySourceStatusSchema,signalCoverage:summarySignalCoverageListSchema,replacement:summaryReviewReplacementSchema}).strict().superRefine((value,context)=>{if(value.sourceStatus==='adequate'&&!value.signalCoverage.some(signal=>signal.status!=='covered'))context.addIssue({code:'custom',message:'REPLACE requires a source gap, contradiction, or at least one non-covered signal',path:['sourceStatus']})});
export const summaryReviewResultSchema=z.union([summaryReviewKeepSchema,summaryReviewReplaceSchema]);
export type SummaryReviewResult=z.infer<typeof summaryReviewResultSchema>;
export const summaryReviewToolName='review_summary' as const;

export const importIssueCodeSchema=z.enum([
  'missing-content','duplicate-content','broken-reading-order','front-matter','caption-association',
  'figure-missing','figure-cropped','table-overflow','equation-degraded','citation-mismatch',
  'template-chrome','raw-field-leak','unreadable-layout','responsive-regression','missing-alt-text',
]);
export type ImportIssueCode=z.infer<typeof importIssueCodeSchema>;
export const importRepairProposalSchema=z.discriminatedUnion('type',[
  z.object({type:z.literal('set-object-layout'),targetRef:z.string().min(1).max(64),width:z.enum(['auto','content','full']),alignment:z.enum(['left','center','right']),enlargeable:z.boolean()}),
  z.object({type:z.literal('wrap-overflow'),targetRef:z.string().min(1).max(64)}),
  z.object({type:z.literal('clear-fixed-dimensions'),targetRef:z.string().min(1).max(64)}),
  z.object({type:z.literal('restore-svg-semantics'),targetRef:z.string().min(1).max(64)}),
  z.object({type:z.literal('join-source-fragments'),targetRef:z.string().min(1).max(64),sourceRefs:z.array(z.string().min(1).max(64)).min(1).max(7)}),
  z.object({type:z.literal('suppress-source-chrome'),targetRef:z.string().min(1).max(64),sourceRef:z.string().min(1).max(64)}),
  z.object({type:z.literal('associate-caption'),targetRef:z.string().min(1).max(64),captionRef:z.string().min(1).max(64)}),
  z.object({type:z.literal('move-object'),targetRef:z.string().min(1).max(64),destinationRef:z.string().min(1).max(64),position:z.enum(['before','after'])}),
  z.object({type:z.literal('set-semantic-role'),targetRef:z.string().min(1).max(64),role:z.enum(['title','author','affiliation','abstract','keywords','heading','caption','body'])}),
  z.object({type:z.literal('draft-alt-text'),targetRef:z.string().min(1).max(64),text:z.string().min(1).max(1000)}),
]);
export type ImportRepairProposal=z.infer<typeof importRepairProposalSchema>;
export const academicRepairBatchProposalSchema=z.union([
  importRepairProposalSchema,
  z.object({
    type:z.literal('derived-html-css-patch'),
    targetRefs:z.array(z.string().min(1).max(64)).min(1).max(20),
    patch:z.string().min(2).max(20_000),
  }).strict(),
]);
export type AcademicRepairBatchProposal=z.infer<typeof academicRepairBatchProposalSchema>;
export const academicReviewIssueDecisionSchema=z.enum(['accepted','dismissed','manual']);
export type AcademicReviewIssueDecision=z.infer<typeof academicReviewIssueDecisionSchema>;
export const academicReviewerPolicyActionSchema=z.enum(['require-stronger-evidence','lower-priority','increase-scrutiny','context-note']);
export type AcademicReviewerPolicyAction=z.infer<typeof academicReviewerPolicyActionSchema>;
export const importAuditFindingInputSchema=z.object({
  issueCode:importIssueCodeSchema,
  severity:z.enum(['info','warning','error']),
  evidenceRefs:z.array(z.string().min(1).max(64)).min(1).max(20),
  targetRefs:z.array(z.string().min(1).max(64)).max(20).default([]),
  observation:z.string().min(1).max(2000),
  sourceComparison:z.string().max(2000).default(''),
  confidence:z.enum(['low','medium','high']),
  suggestedRepair:importRepairProposalSchema.nullable().default(null),
  requestedEvidenceRefs:z.array(z.string().min(1).max(64)).max(20).default([]),
}).strict();
export const importAuditReportSchema=z.object({
  version:z.literal(1),
  verdict:z.enum(['clean','review','blocking']),
  coverage:z.object({reviewedRefs:z.array(z.string().min(1).max(64)).max(500),unreviewedRefs:z.array(z.string().min(1).max(64)).max(500)}).strict(),
  findings:z.array(importAuditFindingInputSchema).max(200),
}).strict();
export type ImportAuditReport=z.infer<typeof importAuditReportSchema>;
export const importAuditToolName='report_import_findings' as const;

export type RunEvent =
  | { type: 'text_delta'; delta: string }
  | { type: 'citation'; citation: Citation }
  | { type: 'tool_call'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; id: string; output: unknown }
  | { type: 'usage'; inputTokens: number; outputTokens: number }
  | { type: 'completed'; finishReason: string; responseId?: string }
  | { type: 'cancelled' }
  | { type: 'error'; code: string; message: string; retryable: boolean };

export interface ProviderRunRequest {
  model: ModelDefinition; messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
  image?: { mimeType: string; data: string };
  images?: Array<{ id?: string; mimeType: string; data: string; detail?: 'low'|'high'|'original'|'auto' }>;
  tools?: Array<{ name: string; schema: unknown }>;
  previousResponseId?: string;
  requiredToolName?: string;
  store?: boolean;
  signal?: AbortSignal;
}
export interface ModelProvider {
  listModels(): Promise<ModelDefinition[]>;
  estimateContext(request: ProviderRunRequest): number;
  run(request: ProviderRunRequest): AsyncIterable<RunEvent>;
}

export type ArtifactKind = 'tldr' | 'half-page' | 'compact' | 'visual-recap' | 'diagram';
export interface KnowledgeArtifact { id: string; documentVersionId: string; kind: ArtifactKind; version: number; scopeType: 'document'|'section'|'answer'|'thread'; scopeId: string; content: unknown; sourceRefs: string[]; promoted: boolean; createdAt: string }
