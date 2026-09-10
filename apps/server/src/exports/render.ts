import {readFile} from 'node:fs/promises';import * as cheerio from 'cheerio';import PDFDocument from 'pdfkit';import {row,rows} from '../db/index.js';
import{effectiveVersion}from'../edits/effective.js';
import { pdfSelectorSchema } from '@profread/shared';
import { pdfPages, type RepresentationRow } from '../pdf/repository.js';
export interface ExportData{title:string;sourceName:string;html:string;highlights:any[];annotations:any[];artifacts:any[];messages:any[];sourceKind?:'html'|'pdf';representationId?:string;sourceVersionId?:string;sourceVersion?:number}
interface StoredAsset{id:string;mime_type:string;storage_path:string}

export async function embedDocumentAssets(html:string,versionId:string,assets:StoredAsset[]):Promise<string>{
  const content=new Map<string,Buffer>();
  for(const asset of assets)content.set(asset.id,await readFile(asset.storage_path));
  const dataUrls=new Map<string,string>();
  for(const asset of assets)if(asset.mime_type!=='text/css')dataUrls.set(asset.id,`data:${asset.mime_type};base64,${content.get(asset.id)!.toString('base64')}`);
  for(const asset of assets)if(asset.mime_type==='text/css'){
    let stylesheet=content.get(asset.id)!.toString('utf8');
    for(const [assetId,dataUrl] of dataUrls)stylesheet=stylesheet.replaceAll(`/api/assets/${versionId}/${assetId}`,dataUrl);
    dataUrls.set(asset.id,`data:text/css;base64,${Buffer.from(stylesheet).toString('base64')}`);
  }
  for(const [assetId,dataUrl] of dataUrls)html=html.replaceAll(`/api/assets/${versionId}/${assetId}`,dataUrl);
  return html;
}

export async function exportData(documentId:string,fullTranscript:boolean,representationId?:string):Promise<ExportData>{
  let source=row<{title:string;id:string;version:number;source_name:string;sanitized_html_path:string|null}>(`SELECT d.title,v.id,v.version,v.source_name,v.sanitized_html_path FROM documents d JOIN document_versions v ON v.document_id=d.id WHERE d.id=? ORDER BY v.version DESC LIMIT 1`,documentId);
  if(!source)throw new Error('Document not found');
  const representations=rows<RepresentationRow>("SELECT r.* FROM document_representations r JOIN document_versions v ON v.id=r.document_version_id WHERE v.document_id=? AND (r.kind='pdf' OR v.id=?) ORDER BY v.version DESC",documentId,source.id);
  const preferred=representationId??row<{representation_id:string|null}>('SELECT representation_id FROM document_view_preferences WHERE document_id=?',documentId)?.representation_id;
  const selected=representations.find(item=>item.id===preferred)??(!representationId?(representations.find(item=>item.kind==='html')??representations[0]):undefined);
  if(representationId&&!selected)throw new Error('Representation does not belong to this article version');
  const sourceKind=selected?.kind??'html';
  if(selected?.kind==='pdf')source=row<typeof source>('SELECT d.title,v.id,v.version,v.source_name,v.sanitized_html_path FROM documents d JOIN document_versions v ON v.document_id=d.id WHERE d.id=? AND v.id=?',documentId,selected.document_version_id)!;
  let html:string;
  if(sourceKind==='pdf')html=`<!doctype html><html><head><meta charset="utf-8"><meta name="generator" content="ProfRead"><title>${escape(source.title)} — study notes</title></head><body><h1>${escape(source.title)}</h1><p>Study notes for ${escape(source.source_name)}. Citations refer to pages in the original PDF.</p></body></html>`;
  else{
    if(!source.sanitized_html_path)throw new Error('HTML reading is unavailable for this article');
    const version=effectiveVersion(source.id)!;
    html=await readFile(version.htmlPath,'utf8');
    const assets=rows<StoredAsset>('SELECT id,mime_type,storage_path FROM assets WHERE document_version_id=?',source.id);
    html=(await embedDocumentAssets(html,source.id,assets)).replace(/<script[^>]*>[^]*?<\/script>/gi,'');
  }
  const inRepresentation=(value:{representation_id?:string|null})=>!value.representation_id?sourceKind==='html':value.representation_id===selected?.id;
  const cite=(value:any)=>{
    if(!value.selector_json||selected?.kind!=='pdf')return value;
    const parsed=pdfSelectorSchema.safeParse(JSON.parse(value.selector_json));if(!parsed.success)return value;
    const selector=parsed.data,pages=new Map(pdfPages(selected.id,selector.extractionRevision).map(page=>[page.page,page]));
    const readerPages=selector.segments.map(segment=>segment.page),sourcePages=readerPages.map(page=>pages.get(page)?.sourcePage??(selected.source_page_start??1)+page-1);
    const plural=sourcePages.length>1?'pages':'page';
    const citation=`Source PDF ${plural} ${sourcePages.join(', ')}${sourcePages.some((page,i)=>page!==readerPages[i])?` (reader ${plural} ${readerPages.join(', ')})`:''}`;
    return{...value,citation,selector};
  };
  const highlights=rows<any>(`SELECT h.*,a.exact_quote,a.block_id,a.representation_id,a.selector_json FROM highlights h JOIN anchors a ON a.id=h.anchor_id WHERE a.document_version_id=? AND h.checked=1 ORDER BY a.start_offset`,source.id).filter(inRepresentation).map(cite);
  const annotations=rows<any>(`SELECT t.id,t.annotation_text,a.exact_quote,a.block_id,a.representation_id,a.selector_json FROM threads t JOIN anchors a ON a.id=t.anchor_id WHERE a.document_version_id=? AND t.annotation_text IS NOT NULL AND trim(t.annotation_text)<>'' ORDER BY a.start_offset,t.created_at`,source.id).filter(inRepresentation).map(cite);
  const artifacts=rows<any>('SELECT * FROM artifacts WHERE document_version_id=? AND promoted=1 ORDER BY created_at',source.id).filter(inRepresentation).map(value=>({...value,content:JSON.parse(value.content_json),sourceRefs:JSON.parse(value.source_refs_json)}));
  const messages=fullTranscript?rows<any>(`SELECT m.*,t.representation_id FROM messages m JOIN threads t ON t.id=m.thread_id WHERE t.document_id=? ORDER BY m.created_at`,documentId).filter(inRepresentation).map(message=>({...message,sourceCitations:sourceKind==='pdf'&&message.model_run_id?rows<any>('SELECT evidence_id id,label,selector_json FROM source_citations WHERE model_run_id=? ORDER BY evidence_id',message.model_run_id).map(cite).filter(value=>value.selector?.representationId===selected?.id):[]})):[];
  return{title:source.title,sourceName:source.source_name,html,highlights,annotations,artifacts,messages,sourceKind,sourceVersionId:source.id,sourceVersion:source.version,...(selected?{representationId:selected.id}:{})};
}
const escape=(s:string)=>s.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
export function renderHtml(data:ExportData):string{
  if(data.sourceKind!=='pdf')return renderLegacyHtml(data);
  const citation=(value:any)=>value.citation?`<p class="source-citation">${escape(value.citation)}</p>`:'';
  const highlights=data.highlights.map(value=>`<article><blockquote>${escape(value.exact_quote||'Selected PDF region')}</blockquote>${citation(value)}<p>${escape(value.note||'')}</p></article>`).join('');
  const annotations=data.annotations.map(value=>`<article><h3>${escape(value.exact_quote||'Selected PDF region')}</h3>${citation(value)}<p>${escape(value.annotation_text)}</p></article>`).join('');
  const report=`<section class="export-notes"><h2>Checked PDF highlights</h2>${highlights}${annotations?`<h2>Curated article annotations</h2>${annotations}`:''}</section>`;
  return renderLegacyHtml({...data,html:data.html.replace('</body>',`${report}</body>`),highlights:[],annotations:[],messages:pdfDiscussion(data.messages)});
}
function pdfDiscussion(messages:any[]):any[]{return messages.map(message=>({...message,content:[message.content,...(message.sourceCitations??[]).map((citation:any)=>`[${citation.id}] ${citation.citation??citation.label}`)].join('\n')}))}
function withPdfCitations(data:ExportData):ExportData{
  if(data.sourceKind!=='pdf')return data;
  return{...data,title:`${data.title} — study notes`,highlights:data.highlights.map(value=>({...value,exact_quote:value.exact_quote||'Selected PDF region',note:[value.citation,value.note||'Checked passage from the source PDF.'].filter(Boolean).join('. ')})),annotations:data.annotations.map(value=>({...value,exact_quote:value.exact_quote||'Selected PDF region',annotation_text:[value.citation,value.annotation_text].filter(Boolean).join('\n')})),messages:pdfDiscussion(data.messages)};
}
export function renderMarkdown(data:ExportData):string{return renderLegacyMarkdown(withPdfCitations(data))}
export async function renderPdf(data:ExportData):Promise<Buffer>{return renderLegacyPdf(withPdfCitations(data))}
function renderLegacyHtml(data:ExportData):string{const $=cheerio.load(data.html);for(const highlight of data.highlights){const target=$(`[data-block-id="${highlight.block_id}"]`).first();if(!target.length)continue;target.addClass('profread-highlight');if(highlight.note&&highlight.note.length<=400)target.attr('data-note',highlight.note).attr('tabindex','0');}const footnotes=data.highlights.filter(h=>h.note&&h.note.length>400&&h.note.length<=1200),appendix=[...data.highlights.filter(h=>h.note&&h.note.length>1200).map(h=>({title:h.exact_quote,content:h.note})),...data.artifacts.map(a=>({title:a.kind,content:typeof a.content==='string'?a.content:JSON.stringify(a.content,null,2)}))];$('head').append(`<style>.profread-highlight{background:#ffe58a}.profread-highlight[data-note]{text-decoration:underline dotted;cursor:help}.profread-highlight[data-note]:focus:after,.profread-highlight[data-note]:hover:after{content:attr(data-note);position:absolute;max-width:26rem;background:#222;color:#fff;padding:.7rem;z-index:3}.export-notes{max-width:760px;margin:3rem auto;padding:1rem}</style>`);$('body').append(`<section class="export-notes"><h2>Study notes</h2>${footnotes.map((n,i)=>`<p><sup>${i+1}</sup> ${escape(n.note)}</p>`).join('')}${data.annotations.length?`<h2>Curated article annotations</h2>${data.annotations.map(annotation=>`<article><h3>${escape(annotation.exact_quote)}</h3><p>${escape(annotation.annotation_text)}</p></article>`).join('')}`:''}${appendix.length?`<h2>Appendix</h2>${appendix.map(a=>`<article><h3>${escape(a.title)}</h3><pre>${escape(a.content)}</pre></article>`).join('')}`:''}${data.messages.length?`<h2>Full discussion</h2>${data.messages.map(m=>`<p><strong>${escape(m.role)}:</strong> ${escape(m.content)}</p>`).join('')}`:''}</section>`);return '<!doctype html>'+$.html()}
function renderLegacyMarkdown(data:ExportData):string{const lines=[`# ${data.title}`,'',`Source: ${data.sourceName}`,'','## Checked highlights',''];data.highlights.forEach((h,i)=>{lines.push(`> ${h.exact_quote}[^${i+1}]`,'')});if(data.annotations.length)lines.push('## Curated article annotations','',...data.annotations.flatMap(annotation=>[`### ${annotation.exact_quote}`,annotation.annotation_text,'']));if(data.artifacts.length)lines.push('## Promoted artifacts','',...data.artifacts.flatMap(a=>[`### ${a.kind}`,typeof a.content==='string'?a.content:'```json\n'+JSON.stringify(a.content,null,2)+'\n```','',`Sources: ${a.sourceRefs.join(', ')}`,'']));if(data.messages.length)lines.push('## Discussion appendix','',...data.messages.flatMap(m=>[`**${m.role}:** ${m.content}`,'']));data.highlights.forEach((h,i)=>lines.push(`[^${i+1}]: ${h.note||'Checked passage from the source article.'}`));return lines.join('\n')}
async function renderLegacyPdf(data:ExportData):Promise<Buffer>{return await new Promise((resolve,reject)=>{const doc=new PDFDocument({size:'A4',margin:54,info:{Title:data.title,Creator:'ProfRead'}}),chunks:Buffer[]=[];doc.on('data',(c:Buffer)=>chunks.push(c));doc.on('error',reject);doc.on('end',()=>resolve(Buffer.concat(chunks)));doc.fontSize(24).text(data.title).moveDown(.3).fontSize(9).fillColor('#666').text(`Source: ${data.sourceName}`).moveDown(2);doc.fillColor('#222').fontSize(16).text('Checked highlights').moveDown();for(const [i,h] of data.highlights.entries()){doc.fontSize(11).text(`${i+1}. “${h.exact_quote}”`,{continued:false}).fontSize(9).fillColor('#555').text(h.note||'').fillColor('#222').moveDown()}if(data.annotations.length){doc.fontSize(16).text('Curated article annotations').moveDown();for(const annotation of data.annotations)doc.fontSize(11).text(`“${annotation.exact_quote}”`).fontSize(9).fillColor('#555').text(annotation.annotation_text).fillColor('#222').moveDown()}for(const a of data.artifacts){doc.addPage();if(a.kind==='visual-recap'&&typeof a.content==='object'){const recap=a.content;doc.fontSize(19).text(recap.title??'Visual recap').fontSize(10).fillColor('#555').text(recap.thesis??'').fillColor('#222').moveDown(.5);for(const section of recap.sections??[])doc.fontSize(11).text(section.title).fontSize(8).text(String(section.summary).slice(0,360)).moveDown(.35);doc.fontSize(11).text('Takeaways').fontSize(8).list((recap.takeaways??[]).map((item:string)=>item.slice(0,180)));doc.fontSize(7).fillColor('#666').text(`Sources: ${a.sourceRefs.join(', ')}`,54,780,{width:487,height:20,ellipsis:true})}else{doc.fontSize(18).text(String(a.kind)).moveDown();doc.fontSize(10).text(typeof a.content==='string'?a.content:JSON.stringify(a.content,null,2));doc.moveDown().fontSize(8).fillColor('#666').text(`Sources: ${a.sourceRefs.join(', ')}`).fillColor('#222')}}if(data.messages.length){doc.addPage().fontSize(18).text('Discussion appendix').moveDown();for(const m of data.messages)doc.fontSize(9).text(`${m.role}: ${m.content}`).moveDown()}doc.end()})}
