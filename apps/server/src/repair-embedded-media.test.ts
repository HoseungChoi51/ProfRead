import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import * as cheerio from 'cheerio';
import { describe, expect, it } from 'vitest';
import { row } from './db/index.js';
import { effectiveVersion } from './edits/effective.js';
import { saveEdits, saveSanitizerRefresh } from './edits/index.js';
import { importSource } from './ingest/index.js';
import { repairEmbeddedMedia } from './repair-embedded-media.js';

describe('embedded-media repair',()=>{it('restores media without reverting later text edits',async()=>{
  const marker=randomUUID(),png='data:image/png;base64,iVBORw0KGgo=',imported=await importSource({buffer:Buffer.from(`<title>Repair ${marker}</title><h1>Repair</h1><p>Original passage ${marker}</p><img src="${png}" alt="Diagram"><iframe src="https://www.youtube.com/embed/1kXnsvYfaF4?start=3"></iframe>`),filename:`repair-${marker}.html`,mimeType:'text/html'});if(!imported.versionId)throw new Error('Import failed');
  const versionId=imported.versionId,paragraph=row<{id:string}>('SELECT id FROM blocks WHERE document_version_id=? AND text_content=?',versionId,`Original passage ${marker}`)!,$=cheerio.load(await readFile(effectiveVersion(versionId)!.htmlPath,'utf8'));$('img,iframe').remove();await saveSanitizerRefresh(versionId,$.html());await saveEdits(versionId,1,[{type:'replace-text',blockId:paragraph.id,text:`Edited passage ${marker}`}]);
  const repaired=await repairEmbeddedMedia(versionId),html=await readFile(effectiveVersion(versionId)!.htmlPath,'utf8');expect(repaired).toMatchObject({revision:3,before:{images:0,youtube:0},after:{images:1,youtube:1}});expect(html).toContain(`Edited passage ${marker}`);expect(html).not.toContain(`Original passage ${marker}`);expect(html).toContain(png);expect(html).toContain('https://www.youtube-nocookie.com/embed/1kXnsvYfaF4?start=3');
})});
