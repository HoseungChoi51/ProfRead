import { z } from 'zod';
import { db, now, row } from '../db/index.js';

export const academicImportDefaults = {
  enabled: true,
  maxCalls: 30,
  concurrency: 2,
  sourceReference: true,
  autoApply: false,
} as const;

export const academicImportSettingsSchema = z.object({
  enabled: z.boolean(),
  maxCalls: z.number().int().min(1).max(40),
  concurrency: z.number().int().min(1).max(2),
  sourceReference: z.boolean(),
  autoApply: z.boolean(),
}).strict();

export type AcademicImportSettings = z.infer<typeof academicImportSettingsSchema>;
type StoredSetting = { value_json: string; updated_at: string };
const settingId = 'academic-import';

function storedSetting(): StoredSetting | undefined {
  return row<StoredSetting>('SELECT value_json,updated_at FROM behavior_settings WHERE id=?', settingId);
}

export function academicImportSettings(): AcademicImportSettings {
  const stored = storedSetting();
  if (!stored) return { ...academicImportDefaults };
  try {
    const parsed = academicImportSettingsSchema.safeParse(JSON.parse(stored.value_json));
    return parsed.success ? parsed.data : { ...academicImportDefaults };
  } catch {
    return { ...academicImportDefaults };
  }
}

export function academicImportSettingsResponse() {
  const stored = storedSetting();
  return {
    values: academicImportSettings(),
    defaults: academicImportDefaults,
    customized: Boolean(stored),
    updatedAt: stored?.updated_at ?? null,
  };
}

function isDefault(values: AcademicImportSettings): boolean {
  return Object.entries(academicImportDefaults).every(([key, value]) => values[key as keyof AcademicImportSettings] === value);
}

export function saveAcademicImportSettings(input: unknown) {
  const values = academicImportSettingsSchema.parse(input);
  if (isDefault(values)) db.prepare('DELETE FROM behavior_settings WHERE id=?').run(settingId);
  else db.prepare(`INSERT INTO behavior_settings(id,value_json,updated_at) VALUES(?,?,?)
    ON CONFLICT(id) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at`).run(settingId, JSON.stringify(values), now());
  return academicImportSettingsResponse();
}

export function resetAcademicImportSettings() {
  db.prepare('DELETE FROM behavior_settings WHERE id=?').run(settingId);
  return academicImportSettingsResponse();
}
