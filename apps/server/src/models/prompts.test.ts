import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import {
  contractForAction,
  promptTemplate,
  renderPrompt,
  requestForAction,
  resetPromptTemplate,
  savePromptTemplate,
  validatePromptTemplate,
} from './prompts.js';

const app = await buildApp();

afterEach(() => {
  resetPromptTemplate('contract.explain');
  resetPromptTemplate('request.polish-note');
  resetPromptTemplate('user.envelope');
});
afterAll(() => app.close());

describe('prompt templates', () => {
  it('renders scoped requests and readable context variables', () => {
    expect(requestForAction('tldr', 'A useful answer', 'answer')).toBe('Create a tldr from this answer:\nA useful answer');
    expect(requestForAction('ask', 'Why does that follow?', 'answer')).toBe('Why does that follow?');
    expect(requestForAction('polish-note', 'causal caveat; clarify scope', 'thread')).toContain('causal caveat; clarify scope');
    expect(contractForAction('polish-note')).toContain('one or two complete sentences');
    expect(contractForAction('document-write')).toContain('propose_document_edits');
    expect(contractForAction('document-write')).toContain('short block ref');
    expect(contractForAction('document-write')).toContain('output version 1');
    expect(contractForAction('review-summary')).toContain('review_summary');
    for (const action of ['summarize', 'tldr', 'half-page', 'visual-recap'] as const) {
      expect(contractForAction(action)).toContain('[IMPORTANT]');
      expect(contractForAction(action)).toContain('[READER COMMENT]');
      expect(contractForAction(action)).toContain('[OPEN QUESTION]');
    }
    expect(renderPrompt('user.envelope', {
      contextTier: 'study',
      articleContext: 'Article body',
      selectedAnchor: 'Selected phrase',
      neighboringBlock: 'Nearby paragraph',
      discussionBranch: 'user: Why?',
      curatedNotes: 'Checked note',
      action: 'explain',
      request: 'Explain',
      contract: '',
    })).toContain('User request: Explain');
    expect(renderPrompt('context.cache-generation', { briefMax: '3000', studyMax: '12000', articleText: 'Article body' })).toContain('Article body');
    const writerEnvelope=renderPrompt('writer.envelope',{documentJson:'{"v":2,"blocks":[["b0","p","Body"]]}',sourceSnapshots:'{"v":2,"sources":[]}',writerConversation:'{"v":2,"messages":[]}',previousProposal:'(none)',instruction:'Improve clarity',contract:contractForAction('document-write')});
    expect(writerEnvelope).toContain('Improve clarity');expect(writerEnvelope).toContain('"b0"');expect(writerEnvelope).toContain('compact JSON tuples');
    const review=renderPrompt('summary-review.envelope',{articleText:'Current article',artifactKind:'tldr',existingSummary:'"Existing"',freshnessReasons:'reader-signals-changed',readerSignals:'[]',contract:contractForAction('review-summary')});
    expect(review).toContain('Complete current article');expect(review).toContain('Prefer KEEP');expect(review).toContain('replacement to null');expect(review).toContain('explanation; use null');
  });

  it('persists overrides and removes them when reset', () => {
    expect(promptTemplate('contract.explain')).toBe('');
    savePromptTemplate('contract.explain', 'Use one analogy and stay under 120 words.');
    expect(promptTemplate('contract.explain')).toBe('Use one analogy and stay under 120 words.');
    resetPromptTemplate('contract.explain');
    expect(promptTemplate('contract.explain')).toBe('');
    savePromptTemplate('request.polish-note', 'Polish this: {{draft}}');
    expect(requestForAction('polish-note', 'rough keywords')).toBe('Polish this: rough keywords');
  });

  it('rejects unknown, malformed, and missing variables', () => {
    expect(() => validatePromptTemplate('contract.explain', '{{articleContext}}')).toThrow('Unknown variable');
    expect(() => validatePromptTemplate('user.envelope', '{{articleContext}} {{action}}')).toThrow('request');
    expect(() => validatePromptTemplate('contract.explain', '{{broken')).toThrow('Malformed');
    expect(() => validatePromptTemplate('request.polish-note', 'No draft placeholder')).toThrow('draft');
  });
});

describe('prompt settings API', () => {
  it('lists, edits, validates, and resets templates through authenticated settings', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/settings/prompts' })).statusCode).toBe(401);
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      remoteAddress: '127.0.0.40',
      payload: { password: 'test-owner-password' },
    });
    const cookie = login.cookies.map(item => `${item.name}=${item.value}`).join('; ');
    const csrf = login.cookies.find(item => item.name === 'afterdraft_csrf')!.value;
    const headers = { cookie, 'x-csrf-token': csrf };
    const listed = await app.inject({ method: 'GET', url: '/api/settings/prompts', headers: { cookie } });
    expect(listed.statusCode).toBe(200);
    expect(JSON.parse(listed.body).find((item: { key: string }) => item.key === 'visual-recap.image')).toMatchObject({
      category: 'Visual recap',
      overridden: false,
      variables: ['visualRecapJson'],
    });
    expect(JSON.parse(listed.body).find((item: { key: string }) => item.key === 'context.cache-generation')).toMatchObject({ category: 'Context', overridden: false });
    expect(JSON.parse(listed.body).find((item: { key: string }) => item.key === 'request.polish-note')).toMatchObject({ category: 'Action requests', variables: ['draft'] });
    const modelSettings = await app.inject({ method: 'GET', url: '/api/settings/models', headers: { cookie } });
    expect(JSON.parse(modelSettings.body).taskRoutes).toContainEqual({ action: 'polish-note', modelId: 'gpt-5.6-luna' });
    expect(JSON.parse(modelSettings.body).taskRoutes).toContainEqual({ action: 'document-write', modelId: 'gpt-5.6-sol' });
    expect(JSON.parse(modelSettings.body).taskRoutes).toContainEqual({ action: 'review-summary', modelId: 'gpt-5.6-terra' });
    const saved = await app.inject({
      method: 'PUT',
      url: '/api/settings/prompts/contract.explain',
      headers,
      payload: { template: 'Explain with one concrete analogy.' },
    });
    expect(saved.statusCode).toBe(200);
    expect(promptTemplate('contract.explain')).toBe('Explain with one concrete analogy.');
    const invalid = await app.inject({
      method: 'PUT',
      url: '/api/settings/prompts/user.envelope',
      headers,
      payload: { template: '{{articleContext}} {{action}}' },
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.body).toContain('request');
    const reset = await app.inject({ method: 'DELETE', url: '/api/settings/prompts/contract.explain', headers });
    expect(reset.statusCode).toBe(200);
    expect(promptTemplate('contract.explain')).toBe('');
  });
});
