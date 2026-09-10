import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { nanoid } from 'nanoid';
import { pdfSelectorSchema, type DocumentRepresentation, type OcrLanguage, type PdfManifest, type PdfPage, type PdfSelector } from '@profread/shared';
import { config } from '../config.js';
import { db, now, row, rows } from '../db/index.js';

export interface RepresentationRow {
  id:string;document_version_id:string;version?:number;kind:'html'|'pdf';status:DocumentRepresentation['status'];source_hash:string|null;source_path:string|null;
  pdf_hash:string|null;pdf_path:string|null;source_page_start:number|null;source_page_end:number|null;page_count:number|null;
  ocr_language:OcrLanguage;extraction_revision:number;error:string|null;
}
export function representation(id:string):RepresentationRow|undefined{return row<RepresentationRow>('SELECT * FROM document_representations WHERE id=?',id)}
export function ensureHtmlRepresentation(versionId:string):void{
  db.prepare(`INSERT OR IGNORE INTO document_representations(id,document_version_id,kind,status,created_at,updated_at)
    SELECT 'html-'||id,id,'html','ready',created_at,created_at FROM document_versions WHERE id=? AND sanitized_html_path IS NOT NULL`).run(versionId);
}
export function publicRepresentation(value:RepresentationRow):DocumentRepresentation{return{id:value.id,documentVersionId:value.document_version_id,...(value.version?{version:value.version}:{}),kind:value.kind,status:value.status,extractionRevision:value.extraction_revision,...(value.source_hash?{sourceHash:value.source_hash}:{}),...(value.page_count?{pageCount:value.page_count}:{}),...(value.error?{error:value.error}:{})}}
export function retainedPdf(versionId:string):{path:string;pageStart?:number;pageEnd?:number}|undefined{
  const path=join(config.dataDir,'documents',versionId,'source.pdf');
  const existing=row<RepresentationRow>("SELECT * FROM document_representations WHERE document_version_id=? AND kind='pdf'",versionId);
  const selected=row<{selected_page_start:number|null;selected_page_end:number|null}>('SELECT selected_page_start,selected_page_end FROM import_jobs WHERE document_version_id=? AND status=\'published\' ORDER BY created_at DESC LIMIT 1',versionId);
  const source=existing?.source_path??path;
  if(!existsSync(source))return undefined;
  return{path:source,...(selected?.selected_page_start&&selected.selected_page_end?{pageStart:selected.selected_page_start,pageEnd:selected.selected_page_end}:{})};
}
export function documentRepresentations(documentId:string,versionId:string){
  ensureHtmlRepresentation(versionId);
  const values=rows<RepresentationRow>("SELECT r.*,v.version FROM document_representations r JOIN document_versions v ON v.id=r.document_version_id WHERE v.document_id=? AND (r.document_version_id=? OR r.kind='pdf') ORDER BY r.kind,v.version DESC",documentId,versionId);
  const preference=row<{representation_id:string|null}>('SELECT representation_id FROM document_view_preferences WHERE document_id=?',documentId)?.representation_id;
  const preferred=values.find(value=>value.id===preference)??values.find(value=>value.kind==='html')??values[0];
  const job=row<{id:string;status:string}>("SELECT id,status FROM import_jobs WHERE pdf_target_version_id=? AND status IN ('queued','converting','failed') ORDER BY created_at DESC LIMIT 1",versionId);
  return{representations:values.map(publicRepresentation),preferredRepresentationId:preferred?.id??null,pdfSourceAvailable:Boolean(retainedPdf(versionId)),...(job?{pdfJobId:job.id,pdfJobStatus:job.status}:{})};
}
export function pdfPages(representationId:string,revision?:number):PdfPage[]{
  const current=representation(representationId);if(!current)return[];
  const selected=revision??current.extraction_revision;
  return rows<{data_json:string}>(`SELECT p.data_json FROM pdf_page_revisions p WHERE p.representation_id=? AND p.revision<=?
    AND p.revision=(SELECT MAX(other.revision) FROM pdf_page_revisions other WHERE other.representation_id=p.representation_id AND other.page=p.page AND other.revision<=?) ORDER BY p.page`,representationId,selected,selected).map(value=>JSON.parse(value.data_json) as PdfPage);
}
export function pdfManifest(id:string):PdfManifest|undefined{
  const value=representation(id);if(value?.kind!=='pdf'||!value.pdf_hash||!value.source_hash)return undefined;
  const progress=row<{page:number;offset_ratio:number;zoom:number;rotation:number;last_thread_id:string|null}>('SELECT * FROM representation_progress WHERE representation_id=?',id);
  return{representationId:id,sourceHash:value.source_hash,pdfHash:value.pdf_hash,url:`/api/representations/${id}/pdf`,extractionRevision:value.extraction_revision,status:value.status,pages:pdfPages(id),ocrLanguage:value.ocr_language,...(progress?{progress:{page:progress.page,offsetRatio:progress.offset_ratio,zoom:progress.zoom,rotation:progress.rotation,lastThreadId:progress.last_thread_id}}:{})};
}
export function anchorSelector(value:{selector_json?:string|null}):PdfSelector|undefined{if(!value.selector_json)return undefined;const parsed=pdfSelectorSchema.safeParse(JSON.parse(value.selector_json));return parsed.success?parsed.data:undefined}
export function presentAnchoredItem<T extends {selector_json?:string|null;representation_id?:string|null}>(item:T){const selector=anchorSelector(item),source=item.representation_id?representation(item.representation_id):undefined;return{...item,selector:selector??null,representationId:item.representation_id??null,representation:source?.kind??'html'};}
export function validatePdfSelector(versionId:string,input:unknown):PdfSelector{
  const selected=pdfSelectorSchema.parse(input),value=representation(selected.representationId);
  if(value?.kind!=='pdf'||value.document_version_id!==versionId||value.source_hash!==selected.sourceHash||selected.extractionRevision>value.extraction_revision)throw Object.assign(new Error('PDF selection does not match this source revision'),{statusCode:409});
  const pages=new Map(pdfPages(value.id,selected.extractionRevision).map(page=>[page.page,page]));
  const seen=new Set<number>();let lastPage=0;
  for(const segment of selected.segments){
    const page=pages.get(segment.page);if(!page||seen.has(segment.page)||segment.page<lastPage)throw Object.assign(new Error('PDF selection has an invalid page sequence'),{statusCode:409});seen.add(segment.page);lastPage=segment.page;
    const [x0,y0,x1,y1]=page.view;
    for(const quad of segment.quads){for(let i=0;i<8;i+=2)if(quad[i]!<x0-1||quad[i]!>x1+1||quad[i+1]!<y0-1||quad[i+1]!>y1+1)throw Object.assign(new Error('PDF selection is outside its page'),{statusCode:409});}
    if(selected.kind==='pdf-text'){
      const start=segment.startOffset!,end=segment.endOffset!,exact=page.text.slice(start,end);
      if(!exact||end>page.text.length||exact!==segment.exact)throw Object.assign(new Error('PDF text changed; select the passage again'),{statusCode:409});
      // Geometry for text must intersect source spans from the quoted range,
      // not an arbitrary screenshot supplied alongside an unrelated quote.
      const items=page.items.filter(item=>item.end>start&&item.start<end);
      if(!items.length)throw Object.assign(new Error('No source geometry for selected text'),{statusCode:409});
      const bounds=(q:number[])=>[Math.min(q[0]!,q[2]!,q[4]!,q[6]!),Math.min(q[1]!,q[3]!,q[5]!,q[7]!),Math.max(q[0]!,q[2]!,q[4]!,q[6]!),Math.max(q[1]!,q[3]!,q[5]!,q[7]!)];
      for(const quad of segment.quads){const a=bounds(quad);if(!items.some(item=>{const b=bounds(item.quad);return a[0]!<=b[2]!+1&&a[2]!>=b[0]!-1&&a[1]!<=b[3]!+1&&a[3]!>=b[1]!-1}))throw Object.assign(new Error('PDF selection geometry does not match the quotation'),{statusCode:409});}
    }
  }
  if(selected.kind==='pdf-text'&&selected.exact!==selected.segments.map(segment=>segment.exact).join('\n'))throw Object.assign(new Error('PDF quotation does not match its page segments'),{statusCode:409});
  return selected;
}
export function createPdfAnchor(versionId:string,input:unknown){
  const selector=validatePdfSelector(versionId,input),id=nanoid(),start=selector.segments[0]?.startOffset??0;
  db.prepare(`INSERT INTO anchors(id,document_version_id,block_id,exact_quote,prefix_text,suffix_text,start_offset,end_offset,block_type,status,representation_id,selector_json,created_at)
    VALUES(?,?,'',?,'','',?,?,?,'attached',?,?,?)`).run(id,versionId,selector.exact,start,start+selector.exact.length,selector.kind,selector.representationId,JSON.stringify(selector),now());
  return{id,...selector,selector,status:'attached'};
}
export function savePdfPages(representationId:string,pages:PdfPage[]):number{
  const value=representation(representationId);if(!value)throw new Error('PDF representation not found');
  const revision=value.extraction_revision+1,time=now();db.exec('BEGIN IMMEDIATE');
  try{
    for(const page of pages){db.prepare('INSERT INTO pdf_page_revisions(representation_id,revision,page,data_json)VALUES(?,?,?,?)').run(representationId,revision,page.page,JSON.stringify(page));db.prepare('DELETE FROM pdf_search_index WHERE representation_id=? AND page=?').run(representationId,page.page);db.prepare('INSERT INTO pdf_search_index(representation_id,page,body)VALUES(?,?,?)').run(representationId,page.page,(page.transcript??page.text).normalize('NFKC'));}
    db.prepare('UPDATE document_representations SET extraction_revision=?,updated_at=? WHERE id=?').run(revision,time,representationId);
    db.exec('COMMIT');return revision;
  }catch(error){db.exec('ROLLBACK');throw error;}
}
