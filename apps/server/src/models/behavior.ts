import { z } from 'zod';
import { db, now, row } from '../db/index.js';

export const contextBehaviorDefaults = {
  fullArticleThresholdTokens: 1200,
  reservedPromptTokens: 4000,
  quickContextMaxTokens: 3000,
  quickContextPercent: 25,
  studyContextMaxTokens: 12000,
  studyContextPercent: 60,
  threadAncestorLimit: 32,
  digestOlderMessageCharacters: 600,
  digestLatestMessageCharacters: 2000,
};

export const contextBehaviorDefinitions = [
  { key: 'fullArticleThresholdTokens', label: 'Full article threshold', description: 'Articles below this estimate are sent in full instead of using a cached context.', min: 100, max: 20000, step: 100, unit: 'tokens' },
  { key: 'reservedPromptTokens', label: 'Reserved prompt budget', description: 'Extra tokens reserved for instructions, history, and the model response when choosing a context.', min: 0, max: 64000, step: 250, unit: 'tokens' },
  { key: 'quickContextMaxTokens', label: 'Quick context maximum', description: 'Maximum size of the compact context used for short actions.', min: 256, max: 64000, step: 256, unit: 'tokens' },
  { key: 'quickContextPercent', label: 'Quick context proportion', description: 'Maximum fraction of the source article used for the compact context.', min: 5, max: 100, step: 5, unit: '%' },
  { key: 'studyContextMaxTokens', label: 'Study context maximum', description: 'Maximum size of the detailed context used for deeper questions.', min: 512, max: 128000, step: 512, unit: 'tokens' },
  { key: 'studyContextPercent', label: 'Study context proportion', description: 'Maximum fraction of the source article used for the detailed context.', min: 5, max: 100, step: 5, unit: '%' },
  { key: 'threadAncestorLimit', label: 'Conversation turn limit', description: 'Maximum number of ancestor turns included from the active discussion branch.', min: 1, max: 128, step: 1, unit: 'turns' },
  { key: 'digestOlderMessageCharacters', label: 'Older turn excerpt', description: 'Maximum characters retained from each older discussion turn.', min: 100, max: 10000, step: 100, unit: 'characters' },
  { key: 'digestLatestMessageCharacters', label: 'Latest turn excerpt', description: 'Maximum characters retained from the newest discussion turn.', min: 200, max: 20000, step: 100, unit: 'characters' },
] as const;

export const contextBehaviorSchema = z.object({
  fullArticleThresholdTokens: z.number().int().min(100).max(20000), reservedPromptTokens: z.number().int().min(0).max(64000),
  quickContextMaxTokens: z.number().int().min(256).max(64000), quickContextPercent: z.number().int().min(5).max(100),
  studyContextMaxTokens: z.number().int().min(512).max(128000), studyContextPercent: z.number().int().min(5).max(100),
  threadAncestorLimit: z.number().int().min(1).max(128), digestOlderMessageCharacters: z.number().int().min(100).max(10000),
  digestLatestMessageCharacters: z.number().int().min(200).max(20000),
}).superRefine((values, context) => {
  if (values.studyContextMaxTokens < values.quickContextMaxTokens) context.addIssue({ code: 'custom', path: ['studyContextMaxTokens'], message: 'Study context maximum must be at least the quick context maximum.' });
  if (values.studyContextPercent < values.quickContextPercent) context.addIssue({ code: 'custom', path: ['studyContextPercent'], message: 'Study context proportion must be at least the quick context proportion.' });
  if (values.digestLatestMessageCharacters < values.digestOlderMessageCharacters) context.addIssue({ code: 'custom', path: ['digestLatestMessageCharacters'], message: 'Latest turn excerpt must be at least the older turn excerpt.' });
});

export type ContextBehaviorSettings = z.infer<typeof contextBehaviorSchema>;
type StoredBehavior = { value_json: string; updated_at: string };

function storedBehavior() { return row<StoredBehavior>('SELECT value_json, updated_at FROM behavior_settings WHERE id = ?', 'context-assembly'); }
export function contextBehaviorSettings(): ContextBehaviorSettings {
  const stored = storedBehavior();
  if (!stored) return { ...contextBehaviorDefaults };
  try {
    const parsed = contextBehaviorSchema.safeParse(JSON.parse(stored.value_json));
    return parsed.success ? parsed.data : { ...contextBehaviorDefaults };
  } catch { return { ...contextBehaviorDefaults }; }
}
function isDefault(values: ContextBehaviorSettings) { return Object.entries(contextBehaviorDefaults).every(([key, value]) => values[key as keyof ContextBehaviorSettings] === value); }
export function behaviorSettingsResponse() {
  const stored = storedBehavior();
  return { values: contextBehaviorSettings(), defaults: contextBehaviorDefaults, definitions: contextBehaviorDefinitions, customized: Boolean(stored), updatedAt: stored?.updated_at ?? null };
}
export function invalidateContextCaches(reason: string) {
  db.prepare('DELETE FROM context_cache').run();
  db.prepare('DELETE FROM branch_digests').run();
  db.prepare("UPDATE background_jobs SET status = 'cancelled', error = ?, updated_at = ? WHERE kind = 'contexts' AND status IN ('queued', 'running')").run(reason, now());
}
export function saveContextBehaviorSettings(input: unknown) {
  const values = contextBehaviorSchema.parse(input);
  db.exec('BEGIN IMMEDIATE');
  try {
    if (isDefault(values)) db.prepare('DELETE FROM behavior_settings WHERE id = ?').run('context-assembly');
    else db.prepare(`INSERT INTO behavior_settings (id,value_json,updated_at) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at`).run('context-assembly', JSON.stringify(values), now());
    invalidateContextCaches('Context settings changed'); db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  return behaviorSettingsResponse();
}
export function resetContextBehaviorSettings() {
  db.exec('BEGIN IMMEDIATE');
  try { db.prepare('DELETE FROM behavior_settings WHERE id = ?').run('context-assembly'); invalidateContextCaches('Context settings reset'); db.exec('COMMIT'); }
  catch (error) { db.exec('ROLLBACK'); throw error; }
  return behaviorSettingsResponse();
}
