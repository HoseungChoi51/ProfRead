import { afterEach, describe, expect, it } from 'vitest';
import {
  behaviorSettingsResponse,
  contextBehaviorDefaults,
  contextBehaviorSettings,
  resetContextBehaviorSettings,
  saveContextBehaviorSettings,
} from './behavior.js';

afterEach(() => { resetContextBehaviorSettings(); });

describe('context behavior settings', () => {
  it('uses source defaults, persists an override, and resets it', () => {
    expect(behaviorSettingsResponse()).toMatchObject({ values: contextBehaviorDefaults, customized: false });
    const changed = { ...contextBehaviorDefaults, fullArticleThresholdTokens: 1800, threadAncestorLimit: 24 };
    expect(saveContextBehaviorSettings(changed)).toMatchObject({ values: changed, customized: true });
    expect(contextBehaviorSettings()).toEqual(changed);
    expect(resetContextBehaviorSettings()).toMatchObject({ values: contextBehaviorDefaults, customized: false });
  });

  it('rejects invalid ranges and inconsistent quick/study limits', () => {
    expect(() => saveContextBehaviorSettings({ ...contextBehaviorDefaults, threadAncestorLimit: 0 })).toThrow();
    expect(() => saveContextBehaviorSettings({ ...contextBehaviorDefaults, quickContextMaxTokens: 16000 })).toThrow('Study context maximum');
  });
});
