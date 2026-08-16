import { afterEach, describe, expect, it } from 'vitest';
import {
  academicImportDefaults,
  academicImportSettingsResponse,
  resetAcademicImportSettings,
  saveAcademicImportSettings,
} from './academic-settings.js';

afterEach(() => { resetAcademicImportSettings(); });

describe('academic import settings', () => {
  it('persists bounded review policy and resets to source defaults', () => {
    expect(academicImportSettingsResponse()).toMatchObject({ values: academicImportDefaults, customized: false });
    const changed = { ...academicImportDefaults, maxCalls: 40, autoApply: true };
    expect(saveAcademicImportSettings(changed)).toMatchObject({ values: changed, customized: true });
    expect(resetAcademicImportSettings()).toMatchObject({ values: academicImportDefaults, customized: false });
  });

  it('rejects unbounded call and concurrency limits', () => {
    expect(() => saveAcademicImportSettings({ ...academicImportDefaults, maxCalls: 41 })).toThrow();
    expect(() => saveAcademicImportSettings({ ...academicImportDefaults, concurrency: 3 })).toThrow();
  });
});
