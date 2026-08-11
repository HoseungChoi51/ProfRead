import type { ModelDefinition, ModelProfile, TaskAction } from '@afterdraft/shared';

export type Action = TaskAction;
export interface RouteInput { action: Action; input: string; hasVisual: boolean; webEnabled: boolean; estimatedTokens: number; requiresImageGeneration?: boolean; modelOverride?: string; taskModelId?: string }
export interface RouteDecision { profile: ModelProfile['name']; model: ModelDefinition; reason: string; eligible: ModelDefinition[] }

export function deterministicProfile(input: RouteInput): ModelProfile['name'] | null {
  if (input.action === 'document-write') return 'deep';
  if (input.action === 'review-summary') return 'digest';
  if (input.action === 'research' || input.webEnabled) return 'research';
  if (input.action === 'visualize' || input.action === 'visual-recap') return 'digest';
  if (input.action === 'polish-note') return 'quick';
  if (input.hasVisual) return 'vision';
  if (input.action === 'define' && input.input.trim().split(/\s+/).length <= 3) return 'quick';
  if (input.action === 'explain' || input.action === 'eli14') return 'standard';
  const questions = (input.input.match(/\?/g) ?? []).length;
  if (questions >= 2 || input.input.length > 240) return 'deep';
  if (input.action === 'summarize' || input.action === 'tldr' || input.action === 'half-page' || input.action === 'compact') return 'digest';
  return null;
}

function capable(model: ModelDefinition, input: RouteInput): boolean {
  const c=model.capabilities;
  const structuredAction=input.action==='visualize'||input.action==='document-write'||input.action==='review-summary';
  return model.enabled && c.text && c.streaming && (!input.hasVisual || c.vision) && (!structuredAction || (c.structuredOutput&&c.functionTools)) && (input.action!=='visual-recap'||(c.structuredOutput&&c.imageGeneration)) && (!input.requiresImageGeneration||(c.imageGeneration&&model.protocol==='openai-responses')) && (!(input.action==='research'||input.webEnabled)||c.providerWebSearch) && model.contextWindow >= input.estimatedTokens + model.maxOutput;
}

export function route(input: RouteInput, models: ModelDefinition[], profiles: ModelProfile[], ttft: Record<string,number> = {}, classifiedProfile?: 'quick'|'standard'|'deep'): RouteDecision {
  const selectedModelId=input.modelOverride??input.taskModelId;if(selectedModelId){const model=models.find(m=>m.id===selectedModelId);if(!model||!capable(model,input))throw new Error(`${input.modelOverride?'Overridden':'Configured'} model cannot satisfy this request`);return{profile:deterministicProfile(input)??classifiedProfile??'standard',model,reason:input.modelOverride?'manual override':'configured action route',eligible:[model]};}
  const profile=deterministicProfile(input)??classifiedProfile??((input.input.length>120)?'deep':'standard');
  const configured=profiles.find(p=>p.name===profile)?.modelIds??[];
  const eligible=models.filter(m=>configured.includes(m.id)&&capable(m,input)).sort((a,b)=>a.priority-b.priority||(ttft[a.id]??Number.MAX_SAFE_INTEGER)-(ttft[b.id]??Number.MAX_SAFE_INTEGER));
  if(!eligible.length)throw new Error(`No ${profile} model has the required capabilities and context window`);
  return {profile,model:eligible[0]!,eligible,reason:deterministicProfile(input)?`deterministic ${profile} rule`:`freeform ${classifiedProfile?'quick classification':'deterministic fallback'}`};
}

export function toolsFor(input: Pick<RouteInput,'action'|'webEnabled'>): string[] {
  if(input.action==='document-write')return ['propose_document_edits'];
  if(input.action==='review-summary')return ['review_summary'];
  if(input.action==='visualize')return ['render_diagram'];
  if(input.action==='visual-recap')return ['image_generation'];
  if(input.action==='research'||input.webEnabled)return ['provider_web_search'];
  return [];
}
