import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { strToU8, zipSync } from 'fflate';
import { afterEach, describe, expect, it } from 'vitest';
import { extractDocxFieldProvenance, inventoryDocx } from './ooxml.js';
import { scanZip } from './zip.js';

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function archive(files: Record<string, Uint8Array>): Promise<string> { const root = await mkdtemp(join(tmpdir(), 'afterdraft-ooxml-test-')); temporary.push(root); const path = join(root, 'fixture.zip'); await writeFile(path, zipSync(files)); return path; }

describe('DOCX OOXML preflight', () => {
  it('accounts for scholarly objects, fields, revisions, notes, and page chrome', async () => {
    const document = `<?xml version="1.0"?><w:document xmlns:w="w" xmlns:w14="w14" xmlns:m="m" xmlns:wp="wp" xmlns:mc="mc"><w:body><w:p w14:paraId="ABC123"><w:r><w:t>Body</w:t></w:r><w:ins/><m:oMath/><m:oMathPara><m:oMath/><m:oMath/></m:oMathPara><w:fldChar w:fldCharType="begin"/><w:instrText> ADDIN ZOTERO_ITEM CSL_CITATION </w:instrText><w:instrText> SEQ Figure \\* ARABIC </w:instrText><w:fldChar w:fldCharType="end"/></w:p><w:tbl/><w:drawing><wp:inline><wp:docPr id="1" name="Picture 1"/></wp:inline></w:drawing><w:sectPr/><mc:AlternateContent/></w:body></w:document>`;
    const path = await archive({
      '[Content_Types].xml': strToU8('<Types/>'), 'word/document.xml': strToU8(document), 'word/media/image.png': Uint8Array.of(137, 80, 78, 71),
      'word/header1.xml': strToU8('<w:hdr xmlns:w="w"/>'), 'word/footer1.xml': strToU8('<w:ftr xmlns:w="w"/>'),
      'word/footnotes.xml': strToU8('<w:footnotes xmlns:w="w"><w:footnote w:id="-1"/><w:footnote w:id="0"/><w:footnote w:id="1"/></w:footnotes>'),
      'word/comments.xml': strToU8('<w:comments xmlns:w="w"><w:comment w:id="0"/></w:comments>'),
      'word/_rels/document.xml.rels': strToU8('<Relationships><Relationship TargetMode="External"/></Relationships>'),
      'docProps/core.xml': strToU8('<cp:coreProperties xmlns:cp="cp" xmlns:dc="dc"><dc:title>Fixture &amp; test</dc:title></cp:coreProperties>'),
    });
    const value = await inventoryDocx(path);
    expect(value).toMatchObject({ paragraphs: 1, paragraphIds: 1, tables: 1, drawings: 1, inlineDrawings: 1, math: { objects: 3, inlineObjects: 1, displayObjects: 2, displayGroups: 1 }, fields: { zoteroCitations: 1, sequenceFigures: 1 }, revisions: { insertions: 1 }, footnotes: 1, comments: 1, headers: 1, footers: 1, externalRelationships: 1, metadata: { title: 'Fixture & test' } });
    expect(value.warnings.map(warning => warning.code)).toEqual(expect.arrayContaining(['tracked_changes_accepted', 'page_chrome_ignored', 'missing_alt_text', 'caption_semantics_inconsistent']));
    expect((await extractDocxFieldProvenance(path)).zoteroFields).toHaveLength(1);
  });

  it('rejects traversal paths before extraction', async () => {
    const path = await archive({ '../escape.tex': strToU8('unsafe') });
    await expect(scanZip(path, { extractTo: join(dirname(path), 'out') })).rejects.toThrow(/(?:Unsafe ZIP path|invalid relative path)/);
  });
});

function dirname(path: string): string { return path.slice(0, path.lastIndexOf('/')); }
