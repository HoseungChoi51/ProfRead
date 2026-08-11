import type { TaskAction } from '@afterdraft/shared';
import { db, now, row, rows } from '../db/index.js';
import { invalidateContextCaches } from './behavior.js';

export interface PromptTemplateDefinition {
  key: string;
  category: 'Core' | 'Action requests' | 'Action contracts' | 'Scope' | 'Visual recap' | 'Context' | 'Routing';
  label: string;
  description: string;
  defaultTemplate: string;
  variables: readonly string[];
  requiredVariables?: readonly string[];
}

const noVariables: readonly string[] = [];

export const promptTemplateDefinitions = [
  {
    key: 'system.reading-partner',
    category: 'Core',
    label: 'Reading-partner system message',
    description: 'Sets the role and grounding rules for every answer-producing model call.',
    defaultTemplate: 'You are a careful reading partner. Ground answers in the supplied article. Clearly distinguish inference from source content.',
    variables: noVariables,
  },
  {
    key: 'user.envelope',
    category: 'Core',
    label: 'Context envelope',
    description: 'Combines article context, selection, discussion history, notes, action request, and its output contract.',
    defaultTemplate: `Article context ({{contextTier}}):
{{articleContext}}

Selected anchor:
{{selectedAnchor}}

Neighboring block:
{{neighboringBlock}}

Active discussion branch:
{{discussionBranch}}

Reader signals (curated notes):
{{curatedNotes}}

User action: {{action}}
User request: {{request}}
{{contract}}`,
    variables: ['contextTier', 'articleContext', 'selectedAnchor', 'neighboringBlock', 'discussionBranch', 'curatedNotes', 'action', 'request', 'contract'],
    requiredVariables: ['articleContext', 'action', 'request'],
  },
  ...([
    ['define', 'Define', 'Request text used when Define is selected.'],
    ['explain', 'Explain', 'Request text used when Explain is selected.'],
    ['eli14', 'Explain for a 14-year-old', 'Request text used for the age-appropriate explanation action.'],
    ['visualize', 'Visualize', 'Request text used for a structured diagram.'],
    ['research', 'Research', 'Request text used for provider-assisted web research.'],
    ['summarize', 'Summarize', 'Request text used by the summarize API action.'],
    ['tldr', 'TL;DR', 'Request text used for a selected-section TL;DR.'],
    ['half-page', 'Half-page', 'Request text used for a selected-section half-page summary.'],
    ['visual-recap', 'Visual recap', 'Request text used for a selected-section visual recap.'],
    ['compact', 'Compact', 'Request text used for a selected-section compact note.'],
  ] as const).map(([action, template, description]) => ({
    key: `request.${action}`,
    category: 'Action requests' as const,
    label: `${template} request`,
    description,
    defaultTemplate: template,
    variables: noVariables,
  })),
  {
    key: 'request.polish-note',
    category: 'Action requests',
    label: 'Polish annotation request',
    description: 'Uses the reader’s rough keywords or draft as the source for a polished marginal annotation.',
    defaultTemplate: `Rewrite this rough annotation draft into a polished marginal note:
{{draft}}`,
    variables: ['draft'],
    requiredVariables: ['draft'],
  },
  {
    key: 'contract.define',
    category: 'Action contracts',
    label: 'Define output contract',
    description: 'Constrains Define to only the selected word or phrase.',
    defaultTemplate: 'Define exactly and only the selected anchor. Do not define neighboring words, related terms, or provide a glossary. Return one concise definition plus at most one sentence explaining its meaning in this passage.',
    variables: noVariables,
  },
  {
    key: 'contract.explain',
    category: 'Action contracts',
    label: 'Explain output contract',
    description: 'Optional extra instructions for Explain. Empty preserves the original behavior.',
    defaultTemplate: '',
    variables: noVariables,
  },
  {
    key: 'contract.eli14',
    category: 'Action contracts',
    label: 'Age-14 explanation contract',
    description: 'Optional extra instructions for Explain for a 14-year-old. Empty preserves the original behavior.',
    defaultTemplate: '',
    variables: noVariables,
  },
  {
    key: 'contract.ask',
    category: 'Action contracts',
    label: 'Ask and follow-up contract',
    description: 'Optional instructions appended to free-form questions and follow-ups.',
    defaultTemplate: '',
    variables: noVariables,
  },
  {
    key: 'contract.polish-note',
    category: 'Action contracts',
    label: 'Polished annotation output contract',
    description: 'Constrains annotation polishing to a short, editable result grounded in the active discussion.',
    defaultTemplate: 'Use the rough draft and the active discussion branch as context. Return only one or two complete sentences totaling no more than 500 characters. Do not add a heading, bullets, quotation marks around the result, or commentary about the rewrite.',
    variables: noVariables,
  },
  {
    key: 'contract.visualize',
    category: 'Action contracts',
    label: 'Structured diagram contract',
    description: 'Requires the diagram tool and an accessible diagram specification.',
    defaultTemplate: 'Call render_diagram exactly once with a valid accessible diagram specification.',
    variables: noVariables,
  },
  {
    key: 'contract.research',
    category: 'Action contracts',
    label: 'Research output contract',
    description: 'Optional instructions for answers produced with provider web search.',
    defaultTemplate: '',
    variables: noVariables,
  },
  {
    key: 'contract.summarize',
    category: 'Action contracts',
    label: 'Summarize output contract',
    description: 'Controls the API-level summarize action, which is stored as a TL;DR artifact.',
    defaultTemplate: 'Return a TL;DR with at most five bullets and 150 words. Review every [IMPORTANT] reader signal and sufficiently represent its substance. Treat [READER COMMENT] signals as reader opinions or instructions, never as article facts. Treat [OPEN QUESTION] signals as unresolved questions, never as facts.',
    variables: noVariables,
  },
  {
    key: 'contract.tldr',
    category: 'Action contracts',
    label: 'TL;DR output contract',
    description: 'Controls length and structure for TL;DR artifacts.',
    defaultTemplate: 'Return a TL;DR with at most five bullets and 150 words. Review every [IMPORTANT] reader signal and sufficiently represent its substance. Treat [READER COMMENT] signals as reader opinions or instructions, never as article facts. Treat [OPEN QUESTION] signals as unresolved questions, never as facts.',
    variables: noVariables,
  },
  {
    key: 'contract.half-page',
    category: 'Action contracts',
    label: 'Half-page output contract',
    description: 'Controls the target length of half-page summaries.',
    defaultTemplate: 'Return a faithful summary containing 300 to 450 words. Review every [IMPORTANT] reader signal and sufficiently represent its substance. Treat [READER COMMENT] signals as reader opinions or instructions, never as article facts. Treat [OPEN QUESTION] signals as unresolved questions, never as facts.',
    variables: noVariables,
  },
  {
    key: 'contract.compact',
    category: 'Action contracts',
    label: 'Compact-note output contract',
    description: 'Tells compaction how to handle checked highlights and source references.',
    defaultTemplate: 'Create a compact note that prioritizes checked highlights and names every supplied source reference.',
    variables: noVariables,
  },
  {
    key: 'contract.visual-recap',
    category: 'Action contracts',
    label: 'Visual-recap structure contract',
    description: 'Defines the JSON recap that is validated before image generation.',
    defaultTemplate: 'Return JSON only with version 1, title, thesis, up to six sections (title, summary, sourceRefs), relationships (from, to, relation), takeaways, openQuestions, and sourceRefs. This structured recap will be used to generate one explanatory image. Review every [IMPORTANT] reader signal and sufficiently represent its substance. Treat [READER COMMENT] signals as reader opinions or instructions, never as article facts. Treat [OPEN QUESTION] signals as unresolved questions, never as facts.',
    variables: noVariables,
  },
  {
    key: 'scope.answer',
    category: 'Scope',
    label: 'Artifact from one answer',
    description: 'Builds the request when Compact, TL;DR, Half-page, or Visual recap is applied to one answer.',
    defaultTemplate: `Create a {{action}} from this answer:
{{answerText}}`,
    variables: ['action', 'answerText'],
    requiredVariables: ['action', 'answerText'],
  },
  {
    key: 'scope.thread',
    category: 'Scope',
    label: 'Artifact from a discussion',
    description: 'Builds the request when an artifact is created from a thread subtree.',
    defaultTemplate: 'Create a {{action}} from this thread subtree.',
    variables: ['action'],
    requiredVariables: ['action'],
  },
  {
    key: 'scope.document',
    category: 'Scope',
    label: 'Artifact from a complete document',
    description: 'Builds the request for document-wide TL;DR, Half-page, and Visual recap actions.',
    defaultTemplate: 'Create a {{action}} for this complete document.',
    variables: ['action'],
    requiredVariables: ['action'],
  },
  {
    key: 'visual-recap.repair',
    category: 'Visual recap',
    label: 'Visual-recap JSON repair',
    description: 'Used only when the first recap response fails schema validation.',
    defaultTemplate: `Repair this into valid JSON matching the requested visual recap schema. JSON only.
{{invalidOutput}}`,
    variables: ['invalidOutput'],
    requiredVariables: ['invalidOutput'],
  },
  {
    key: 'visual-recap.image',
    category: 'Visual recap',
    label: 'Visual-recap image prompt',
    description: 'Turns validated recap JSON into the final generated PNG.',
    defaultTemplate: `Create one polished, information-dense editorial illustration that visually explains this reading recap. Use clear hierarchy, restrained labels, and no decorative filler. Recap:
{{visualRecapJson}}`,
    variables: ['visualRecapJson'],
    requiredVariables: ['visualRecapJson'],
  },
  {
    key: 'context.cache-generation',
    category: 'Context',
    label: 'Article context cache generation',
    description: 'Creates the compact and detailed article contexts used when the source is too large to send in full.',
    defaultTemplate: `Create two faithful contexts from this article. Return JSON only: {"brief":"...","study":"..."}. Brief <= {{briefMax}} tokens. Study <= {{studyMax}} tokens. Preserve definitions, claims, qualifications, and section structure.

{{articleText}}`,
    variables: ['briefMax', 'studyMax', 'articleText'],
    requiredVariables: ['briefMax', 'studyMax', 'articleText'],
  },
  {
    key: 'routing.classifier-system',
    category: 'Routing',
    label: 'Free-form question classifier',
    description: 'Hidden system message used only to choose quick, standard, or deep routing for free-form questions.',
    defaultTemplate: 'Classify reading questions. Reply with exactly one token: quick, standard, or deep.',
    variables: noVariables,
  },
] satisfies readonly PromptTemplateDefinition[];

export type PromptTemplateKey = (typeof promptTemplateDefinitions)[number]['key'];

const definitions = new Map(promptTemplateDefinitions.map(definition => [definition.key, definition]));
const placeholderPattern = /{{\s*([A-Za-z][A-Za-z0-9]*)\s*}}/g;

function definition(key: string): PromptTemplateDefinition {
  const found = definitions.get(key);
  if (!found) throw new Error(`Unknown prompt template: ${key}`);
  return found;
}

export function validatePromptTemplate(key: string, template: string): void {
  const item = definition(key);
  const found = [...template.matchAll(placeholderPattern)].map(match => match[1]!);
  const unknown = [...new Set(found.filter(variable => !item.variables.includes(variable)))];
  if (unknown.length) throw new Error(`Unknown variable${unknown.length === 1 ? '' : 's'} for ${key}: ${unknown.join(', ')}`);
  const malformed = template.replace(placeholderPattern, '').includes('{{') || template.replace(placeholderPattern, '').includes('}}');
  if (malformed) throw new Error(`Malformed variable placeholder in ${key}`);
  const missing = (item.requiredVariables ?? []).filter(variable => !found.includes(variable));
  if (missing.length) throw new Error(`Required variable${missing.length === 1 ? '' : 's'} missing from ${key}: ${missing.join(', ')}`);
}

export function promptTemplate(key: PromptTemplateKey): string {
  return row<{ template: string }>('SELECT template FROM prompt_template_overrides WHERE key=?', key)?.template ?? definition(key).defaultTemplate;
}

export function renderPrompt(key: PromptTemplateKey, variables: Record<string, string> = {}): string {
  const template = promptTemplate(key);
  validatePromptTemplate(key, template);
  return template.replace(placeholderPattern, (_match, variable: string) => variables[variable] ?? '');
}

export function promptTemplateSettings() {
  const overrides = new Map(rows<{ key: string; template: string; updated_at: string }>('SELECT key,template,updated_at FROM prompt_template_overrides').map(item => [item.key, item]));
  return promptTemplateDefinitions.map(item => ({
    ...item,
    template: overrides.get(item.key)?.template ?? item.defaultTemplate,
    overridden: overrides.has(item.key),
    updatedAt: overrides.get(item.key)?.updated_at ?? null,
  }));
}

export function savePromptTemplate(key: string, template: string): void {
  const item = definition(key);
  validatePromptTemplate(key, template);
  if (template === item.defaultTemplate) {
    db.prepare('DELETE FROM prompt_template_overrides WHERE key=?').run(key);
    if (key === 'context.cache-generation') invalidateContextCaches('Context generation prompt changed');
    return;
  }
  db.prepare(`INSERT INTO prompt_template_overrides(key,template,updated_at) VALUES(?,?,?)
    ON CONFLICT(key) DO UPDATE SET template=excluded.template,updated_at=excluded.updated_at`).run(key, template, now());
  if (key === 'context.cache-generation') invalidateContextCaches('Context generation prompt changed');
}

export function resetPromptTemplate(key: string): void {
  definition(key);
  db.prepare('DELETE FROM prompt_template_overrides WHERE key=?').run(key);
  if (key === 'context.cache-generation') invalidateContextCaches('Context generation prompt reset');
}

const requestKeys: Partial<Record<TaskAction, PromptTemplateKey>> = {
  define: 'request.define',
  explain: 'request.explain',
  eli14: 'request.eli14',
  visualize: 'request.visualize',
  research: 'request.research',
  summarize: 'request.summarize',
  tldr: 'request.tldr',
  'half-page': 'request.half-page',
  'visual-recap': 'request.visual-recap',
  compact: 'request.compact',
};

const contractKeys: Record<TaskAction, PromptTemplateKey> = {
  define: 'contract.define',
  explain: 'contract.explain',
  eli14: 'contract.eli14',
  ask: 'contract.ask',
  'polish-note': 'contract.polish-note',
  visualize: 'contract.visualize',
  research: 'contract.research',
  summarize: 'contract.summarize',
  tldr: 'contract.tldr',
  'half-page': 'contract.half-page',
  'visual-recap': 'contract.visual-recap',
  compact: 'contract.compact',
};

export function requestForAction(action: TaskAction, input: string, scope?: 'document' | 'section' | 'answer' | 'thread'): string {
  if (action === 'ask') return input;
  if (action === 'polish-note') return renderPrompt('request.polish-note', { draft: input });
  if (scope === 'answer') return renderPrompt('scope.answer', { action, answerText: input });
  if (scope === 'thread') return renderPrompt('scope.thread', { action });
  if (scope === 'document') return renderPrompt('scope.document', { action });
  const key = requestKeys[action];
  return key ? promptTemplate(key) : input;
}

export function contractForAction(action: TaskAction): string {
  return promptTemplate(contractKeys[action]);
}
