import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { convertTex } from './worker-client.js';

const temporary:string[]=[];
afterEach(async()=>{vi.unstubAllGlobals();await Promise.all(temporary.splice(0).map(path=>rm(path,{recursive:true,force:true})))});

describe('academic worker client errors',()=>{
  it('preserves structured entry choices from the worker',async()=>{
    const root=await mkdtemp(join(tmpdir(),'afterdraft-worker-client-'));temporary.push(root);const source=join(root,'draft.zip');await writeFile(source,'zip');
    vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify({error:'Choose a TeX entry',code:'entry_required',entryChoices:['main.tex','paper/supplement.tex']}),{status:409,headers:{'content-type':'application/json'}})));
    await expect(convertTex(source,'draft.zip',undefined)).rejects.toMatchObject({status:409,code:'entry_required',entryChoices:['main.tex','paper/supplement.tex']});
  });
});
