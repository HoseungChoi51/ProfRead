import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { convertTex } from './convert.js';

describe('TeX project entry selection',()=>{
  it('returns structured, portable entry choices before invoking converters',async()=>{
    const source=Buffer.from(zipSync({
      'chapters/paper.tex':strToU8('\\documentclass{article}\\begin{document}Paper\\end{document}'),
      'supplement.tex':strToU8('\\documentclass{article}\\begin{document}Supplement\\end{document}'),
    }));
    await expect(convertTex(source,{filename:'draft.zip'})).rejects.toMatchObject({code:'entry_required',statusCode:409,details:{entryChoices:['chapters/paper.tex','supplement.tex']}});
  });
});
