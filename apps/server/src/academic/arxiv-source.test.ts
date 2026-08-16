import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe,expect,it } from 'vitest';
import { materializeArxivBundle } from './arxiv-source.js';

describe('arXiv normalized source bundle',()=>{
  it('materializes HTML/assets with a verified conversion manifest',async()=>{const directory=await mkdtemp(join(tmpdir(),'afterdraft-arxiv-bundle-')),sourceHash='a'.repeat(64),result=await materializeArxivBundle({arxivId:'2402.08954',sourceUrl:'https://arxiv.org/html/2402.08954',pdfUrl:'https://arxiv.org/pdf/2402.08954',entryPath:'document.html',html:'<article><h1>Paper</h1><img src="assets/figure.png"></article>',assets:[{sourcePath:'assets/figure.png',mimeType:'image/png',bytes:Buffer.from([137,80,78,71,13,10,26,10])}],warnings:[{code:'source-chrome-removed',message:'Removed site chrome'}]},directory,sourceHash);expect(result.manifest).toMatchObject({operation:'convert',source:{kind:'arxiv-html',sha256:sourceHash},output:{entryPath:'document.html'}});expect(result.files.map(file=>file.path).sort()).toEqual(['assets/figure.png','document.html','manifest.json']);expect(await readFile(join(directory,'document.html'),'utf8')).toContain('<h1>Paper</h1>')});
});
