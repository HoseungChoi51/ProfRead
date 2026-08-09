import{describe,expect,it}from'vitest';
import{standaloneHtmlFilename}from'./library.js';

describe('standalone HTML filenames',()=>{
  it('keeps the document title readable while removing cross-platform path characters',()=>{
    expect(standaloneHtmlFilename('  A: Study / Notes?  ','doc_123')).toBe('A Study Notes -- doc_123.html');
  });
  it('uses a readable fallback for an unusable title',()=>{
    expect(standaloneHtmlFilename(' ... ','doc_456')).toBe('Untitled -- doc_456.html');
  });
});
