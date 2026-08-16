import { describe, expect, it } from 'vitest';

import { workerBodyLimit } from './index.js';

describe('worker request bounds', () => {
  it('matches the public 100 MiB upload ceiling and rejects larger configuration', () => {
    const previous = process.env.ACADEMIC_WORKER_MAX_BODY_BYTES;
    try {
      delete process.env.ACADEMIC_WORKER_MAX_BODY_BYTES;
      expect(workerBodyLimit()).toBe(100 * 1024 * 1024);
      process.env.ACADEMIC_WORKER_MAX_BODY_BYTES = String(120 * 1024 * 1024);
      expect(workerBodyLimit()).toBe(100 * 1024 * 1024);
      process.env.ACADEMIC_WORKER_MAX_BODY_BYTES = String(64 * 1024 * 1024);
      expect(workerBodyLimit()).toBe(64 * 1024 * 1024);
    } finally {
      if (previous === undefined) delete process.env.ACADEMIC_WORKER_MAX_BODY_BYTES;
      else process.env.ACADEMIC_WORKER_MAX_BODY_BYTES = previous;
    }
  });
});
