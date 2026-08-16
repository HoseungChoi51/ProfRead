import { describe, expect, it } from 'vitest';
import { estimateModelRequestTokens } from './token-estimate.js';

const request = (content: string) => ({
  messages: [
    { role: 'system' as const, content: 'Follow the instruction.' },
    { role: 'user' as const, content },
  ],
});

describe('model request token estimation', () => {
  it('estimates ordinary ASCII request text', () => {
    const content = 'Rewrite this short paragraph clearly.';
    const estimate = estimateModelRequestTokens(request(content));
    expect(estimate).toBeGreaterThan(Buffer.byteLength(content, 'utf8'));
    expect(estimate).toBeLessThan(300);
  });

  it('uses the UTF-8 byte upper bound for Korean text', () => {
    const content = '이 문장을 더 명확하고 자연스럽게 다듬어 주세요.';
    const emptyEstimate = estimateModelRequestTokens(request(''));
    const koreanTokens = estimateModelRequestTokens(request(content)) - emptyEstimate;
    expect(koreanTokens).toBeGreaterThanOrEqual(Buffer.byteLength(content, 'utf8'));
  });

  it('uses the UTF-8 byte upper bound for emoji and composed sequences', () => {
    const content = '😀🤖🧑‍💻🚀';
    const emptyEstimate = estimateModelRequestTokens(request(''));
    const emojiTokens = estimateModelRequestTokens(request(content)) - emptyEstimate;
    expect(emojiTokens).toBeGreaterThanOrEqual(Buffer.byteLength(content, 'utf8'));
  });

  it('does not apply a four-characters-per-token discount to high-entropy ASCII', () => {
    const content = Array.from({ length: 1_024 }, (_value, index) => String.fromCharCode(33 + ((index * 47) % 94))).join('');
    const emptyEstimate = estimateModelRequestTokens(request(''));
    const contentTokens = estimateModelRequestTokens(request(content)) - emptyEstimate;
    expect(contentTokens).toBeGreaterThanOrEqual(Buffer.byteLength(content, 'utf8'));
    expect(contentTokens).toBeGreaterThan(content.length / 4);
  });

  it('includes function-tool schemas and the forced tool choice', () => {
    const base = request('Improve the document.');
    const withTool = {
      ...base,
      tools: [{
        name: 'propose_document_edits',
        schema: {
          type: 'object',
          properties: { title: { type: 'string' }, changes: { type: 'array', items: { type: 'string' } } },
          required: ['title', 'changes'],
          additionalProperties: false,
        },
      }],
    };
    const schemaEstimate = estimateModelRequestTokens(withTool);
    const forcedEstimate = estimateModelRequestTokens({ ...withTool, requiredToolName: 'propose_document_edits' });
    expect(schemaEstimate).toBeGreaterThan(estimateModelRequestTokens(base));
    expect(forcedEstimate).toBeGreaterThan(schemaEstimate);
  });

  it('is deterministic and monotonic as request content grows', () => {
    const short = request('Revise this.');
    const long = request(`Revise this. ${'Additional context. '.repeat(40)}`);
    expect(estimateModelRequestTokens(short)).toBe(estimateModelRequestTokens(short));
    expect(estimateModelRequestTokens(long)).toBeGreaterThan(estimateModelRequestTokens(short));
  });
});
