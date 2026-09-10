import { describe, expect, it } from 'vitest';
import { runCommand } from './process.js';

describe('converter subprocess environment', () => {
  it('uses a dedicated temporary home and strips provider credentials', async () => {
    const previous = process.env.OPENAI_API_KEY; process.env.OPENAI_API_KEY = 'must-not-leak';
    try {
      const result = await runCommand('env', [], { cwd: '/tmp' });
      expect(result.stdout).toContain('HOME=/tmp/profread-worker-home');
      expect(result.stdout).not.toContain('must-not-leak');
      expect(result.stdout).not.toContain('OPENAI_API_KEY');
    } finally { if (previous === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = previous; }
  });

  it('terminates a child immediately when the request was already aborted', async () => {
    const controller = new AbortController(); controller.abort();
    await expect(runCommand(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { cwd: '/tmp', signal: controller.signal, timeoutMs: 10_000 })).rejects.toMatchObject({ code: 'request_aborted' });
  });
});
