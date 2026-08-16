import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';

import { assertFileWithinWorkerOutputLimit, workerOutputLimit } from './files.js';

describe('worker response bounds', () => {
  it('rejects an archive larger than the configured response limit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'afterdraft-output-limit-')), output = join(root, 'result.zip');
    const previous = process.env.ACADEMIC_WORKER_MAX_OUTPUT_BYTES;
    try {
      await writeFile(output, Buffer.from('too large'));
      process.env.ACADEMIC_WORKER_MAX_OUTPUT_BYTES = '4';
      expect(workerOutputLimit()).toBe(4);
      await expect(assertFileWithinWorkerOutputLimit(output)).rejects.toMatchObject({ code: 'output_too_large', statusCode: 422 });
    } finally {
      if (previous === undefined) delete process.env.ACADEMIC_WORKER_MAX_OUTPUT_BYTES;
      else process.env.ACADEMIC_WORKER_MAX_OUTPUT_BYTES = previous;
      await rm(root, { recursive: true, force: true });
    }
  });
});
