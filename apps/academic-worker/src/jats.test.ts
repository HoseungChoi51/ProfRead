import { describe,expect,it } from 'vitest';
import { jatsTitle } from './jats.js';

describe('JATS conversion helpers',()=>{
  it('extracts a readable article title with inline markup and entities',()=>{
    expect(jatsTitle('<article><front><article-meta><title-group><article-title>Sample-efficient <italic>inverse</italic> design &amp; control</article-title></title-group></article-meta></front></article>')).toBe('Sample-efficient inverse design & control');
  });
  it('falls back to the source filename',()=>expect(jatsTitle('<article><body><p>Text</p></body></article>','pmc-123.xml')).toBe('pmc-123'));
});
