import type { SourceCitation } from '@profread/shared';
import { db, row, rows } from '../db/index.js';
import { representation } from './repository.js';
import type { PdfContextSnapshot } from './context.js';

type RunSourceInput={documentVersionId:string;representationId?:string|undefined;anchorId?:string|undefined;threadId?:string|undefined;reviewArtifactId?:string|undefined};
export function resolvePdfRunSource(input:RunSourceInput):{representationId:string;anchorId?:string}|undefined{
  const version=row<{document_id:string;sanitized_html_path:string|null}>('SELECT document_id,sanitized_html_path FROM document_versions WHERE id=?',input.documentVersionId);
  if(!version)throw Object.assign(new Error('Article version not found'),{statusCode:404});
  const anchor=input.anchorId?row<{representation_id:string|null}>('SELECT representation_id FROM anchors WHERE id=?',input.anchorId):undefined;
  const thread=input.threadId?row<{representation_id:string|null}>('SELECT representation_id FROM threads WHERE id=?',input.threadId):undefined;
  const artifact=input.reviewArtifactId?row<{representation_id:string|null}>('SELECT representation_id FROM artifacts WHERE id=?',input.reviewArtifactId):undefined;
  const bound=anchor?.representation_id??thread?.representation_id??artifact?.representation_id;
  if(bound&&input.representationId&&bound!==input.representationId)throw Object.assign(new Error('AI request source differs from the saved discussion or annotation'),{statusCode:409});
  const selected=bound??input.representationId??(version.sanitized_html_path?undefined:row<{id:string}>("SELECT id FROM document_representations WHERE document_version_id=? AND kind='pdf'",input.documentVersionId)?.id);
  if(!selected)return;
  const source=representation(selected);if(!source||source.document_version_id!==input.documentVersionId)throw Object.assign(new Error('AI source does not belong to this article version'),{statusCode:409});
  if(source.kind==='html')return;
  let anchorId=input.anchorId,current=input.threadId;const seen=new Set<string>();
  // A question on an answer keeps the ancestor's visual selection even though
  // its own thread is anchorless. Its text history alone cannot replace it.
  while(!anchorId&&current&&!seen.has(current)){
    seen.add(current);const parent: {anchor_id:string|null;parent_message_id:string|null}|undefined=row('SELECT anchor_id,parent_message_id FROM threads WHERE id=?',current);
    if(!parent)break;if(parent.anchor_id){anchorId=parent.anchor_id;break;}
    current=parent.parent_message_id?row<{thread_id:string}>('SELECT thread_id FROM messages WHERE id=?',parent.parent_message_id)?.thread_id:undefined;
  }
  return{representationId:selected,...(anchorId?{anchorId}:{})};
}
export function persistPdfRunBasis(runId:string,snapshot:PdfContextSnapshot):void{
  db.prepare('INSERT INTO pdf_run_basis(model_run_id,representation_id,extraction_revision,evidence_json)VALUES(?,?,?,?)').run(runId,snapshot.representationId,snapshot.extractionRevision,JSON.stringify({sourceHash:snapshot.sourceHash,pdfHash:snapshot.pdfHash,coverage:snapshot.coverage,citations:snapshot.citations}));
}
export function savedPdfCitations(runId:string):SourceCitation[]{return rows<{evidence_id:string;label:string;selector_json:string}>('SELECT evidence_id,label,selector_json FROM source_citations WHERE model_run_id=? ORDER BY evidence_id',runId).map(item=>({id:item.evidence_id,label:item.label,selector:JSON.parse(item.selector_json)}));}
export function validatedPdfCitations(answer:string,available:SourceCitation[]):SourceCitation[]{
  const ids=new Set([...answer.matchAll(/\[(pdf-(?:p\d+|selection))\]/g)].map(match=>match[1]));
  return available.filter(citation=>ids.has(citation.id));
}
export function persistPdfCitations(runId:string,answer:string,snapshot:PdfContextSnapshot):SourceCitation[]{
  const citations=validatedPdfCitations(answer,snapshot.citations);
  for(const citation of citations)db.prepare('INSERT OR IGNORE INTO source_citations(id,model_run_id,evidence_id,label,selector_json)VALUES(?,?,?,?,?)').run(`${runId}-${citation.id}`,runId,citation.id,citation.label,JSON.stringify(citation.selector));
  return citations;
}
