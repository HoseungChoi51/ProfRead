import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import * as cheerio from 'cheerio';
import { row, rows } from './db/index.js';
import { effectiveVersion, readEffectiveHtml } from './edits/effective.js';
import { saveSanitizerRefresh } from './edits/index.js';
import { sanitizeDocument } from './ingest/sanitize.js';

const textSelector='h1[data-block-id],h2[data-block-id],h3[data-block-id],h4[data-block-id],h5[data-block-id],h6[data-block-id],p[data-block-id],li[data-block-id],blockquote[data-block-id],pre[data-block-id],figcaption[data-block-id],caption[data-block-id]';

export async function repairEmbeddedMedia(versionId:string){
  const version=effectiveVersion(versionId);if(!version)throw new Error('Document version not found');
  const source=row<{entry_path:string;sanitized_html_path:string}>('SELECT entry_path,sanitized_html_path FROM document_versions WHERE id=?',versionId)!;
  const unsupported=rows<{summary_json:string}>('SELECT summary_json FROM document_edit_revisions WHERE document_version_id=?',versionId).some(item=>Object.keys(JSON.parse(item.summary_json)).some(key=>!['replace-text','sanitizer-refresh'].includes(key)));
  if(unsupported)throw new Error('Automatic media repair is limited to documents with text-only edit history');
  const sourcePath=join(dirname(source.sanitized_html_path),'source.html'),original=await readFile(sourcePath,'utf8'),assets=rows<{id:string;source_path:string}>('SELECT id,source_path FROM assets WHERE document_version_id=?',versionId),assetIds=new Map(assets.map(asset=>[asset.source_path,asset.id]));
  const refreshed=sanitizeDocument(original,source.entry_path,path=>assetIds.has(path)?`/api/assets/${versionId}/${assetIds.get(path)}`:null),$fresh=cheerio.load(refreshed.html),$current=cheerio.load(await readEffectiveHtml(versionId));
  $current(textSelector).each((_index,element)=>{const id=$current(element).attr('data-block-id');if(!id)return;const target=$fresh(`[data-block-id="${id}"]`).first();if(target.length)target.html($current(element).html()??'')});
  const before={images:$current('img[src]').length,youtube:$current('iframe[src*="youtube.com"],iframe[src*="youtube-nocookie.com"]').length},after={images:$fresh('img[src^="data:image/"],img[src^="/api/assets/"]').length,youtube:$fresh('iframe[src*="youtube-nocookie.com"]').length};
  if(after.images<=before.images&&after.youtube<=before.youtube)throw new Error('No missing embedded media was found');
  const saved=await saveSanitizerRefresh(versionId,$fresh.html());return{...saved,before,after};
}

if(import.meta.url===`file://${process.argv[1]}`){const versionId=process.argv[2];if(!versionId)throw new Error('Usage: repair-embedded-media <version-id>');console.log(JSON.stringify(await repairEmbeddedMedia(versionId)))}
