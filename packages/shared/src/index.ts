import { z } from 'zod';

export const protocolSchema = z.enum(['openai-responses', 'chat-completions', 'openrouter']);
export const capabilitySchema = z.object({
  text: z.boolean().default(true), vision: z.boolean().default(false),
  structuredOutput: z.boolean().default(false), functionTools: z.boolean().default(false),
  providerWebSearch: z.boolean().default(false), reasoningControl: z.boolean().default(false),
  streaming: z.boolean().default(true),
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

export const anchorSelectorSchema = z.object({
  blockId: z.string().min(1), exact: z.string(), prefix: z.string().default(''), suffix: z.string().default(''),
  startOffset: z.number().int().nonnegative(), endOffset: z.number().int().nonnegative(),
  blockType: z.enum(['text', 'image', 'svg', 'table', 'diagram']).default('text'),
});
export type AnchorSelector = z.infer<typeof anchorSelectorSchema>;

export const contextBundleSchema = z.object({
  tier: z.enum(['canonical', 'brief', 'study', 'study-with-branch-digest']),
  article: z.string(), anchor: z.string().optional(), neighboringBlock: z.string().optional(),
  branch: z.array(z.object({ role: z.enum(['user', 'assistant']), content: z.string() })).default([]),
  curatedNotes: z.array(z.string()).default([]), tokenEstimate: z.number().int().nonnegative(),
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
});

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
  image?: { mimeType: string; data: string }; tools?: Array<{ name: string; schema: unknown }>;
  previousResponseId?: string;
  signal?: AbortSignal;
}
export interface ModelProvider {
  listModels(): Promise<ModelDefinition[]>;
  estimateContext(request: ProviderRunRequest): number;
  run(request: ProviderRunRequest): AsyncIterable<RunEvent>;
}

export type ArtifactKind = 'tldr' | 'half-page' | 'compact' | 'visual-recap' | 'diagram';
export interface KnowledgeArtifact { id: string; documentVersionId: string; kind: ArtifactKind; version: number; scopeType: 'document'|'section'|'answer'|'thread'; scopeId: string; content: unknown; sourceRefs: string[]; promoted: boolean; createdAt: string }
