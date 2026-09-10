import { afterEach, describe, expect, it, vi } from 'vitest';
import { applicationEnv } from './config.js';

afterEach(()=>vi.unstubAllEnvs());
describe('ProfRead configuration compatibility',()=>{
  it('prefers canonical configuration and falls back only when it is absent',()=>{
    vi.stubEnv('AFTERDRAFT_RENAME_TEST','old'); vi.stubEnv('PROFREAD_RENAME_TEST',undefined);
    expect(applicationEnv('RENAME_TEST')).toBe('old');
    vi.stubEnv('PROFREAD_RENAME_TEST','new'); expect(applicationEnv('RENAME_TEST')).toBe('new');
    vi.stubEnv('PROFREAD_RENAME_TEST',''); expect(applicationEnv('RENAME_TEST')).toBe('');
  });
});
