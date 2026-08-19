import {describe,expect,it} from 'vitest';
import {PublishedFetchError} from './published-fetch.js';
import {extractPublishedDoi,normalizePublishedLocator} from './published-utils.js';

describe('published DOI normalization',()=>{
  it('preserves supported DOI punctuation instead of truncating the identifier',()=>{
    expect(extractPublishedDoi('doi:10.1234/Foo+Bar[2]')).toBe('10.1234/foo+bar[2]');
    const normalized=normalizePublishedLocator('doi:10.1234/Foo+Bar[2]');
    expect(normalized.doi).toBe('10.1234/foo+bar[2]');
    expect(normalized.url.toString()).toBe('https://doi.org/10.1234/foo%2Bbar%5B2%5D');
  });

  it('rejects unsupported trailing bare-DOI input rather than silently importing a prefix',()=>{
    for(const value of ['10.1234/foo?garbage','doi:10.1234/foo#fragment','10.1234/foo bar'])expect(()=>normalizePublishedLocator(value),value).toThrow(PublishedFetchError);
  });

  it('still extracts a DOI from a normal publisher URL without treating its query as identity',()=>{
    const normalized=normalizePublishedLocator('https://publisher.test/doi/10.1234/Foo+Bar[2]?utm_source=mail');
    expect(normalized.doi).toBe('10.1234/foo+bar[2]');
    expect(normalized.url.toString()).toBe('https://publisher.test/doi/10.1234/Foo+Bar[2]');
  });
});
