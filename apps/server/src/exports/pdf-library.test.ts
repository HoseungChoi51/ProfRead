import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { db, now, row } from '../db/index.js';
import { importSource } from '../ingest/index.js';
import { exportLibrary } from './library.js';
import { exportData, renderHtml, renderMarkdown, renderPdf } from './render.js';

const directories:string[]=[],documentIds:string[]=[];
afterEach(async()=>{for(const id of documentIds.splice(0))db.prepare('DELETE FROM documents WHERE id=?').run(id);for(const path of directories.splice(0))await rm(path,{recursive:true,force:true})});

describe('PDF library exports',()=>{
  it('isolates canonical HTML notes and retains every historical PDF source with cited discussions',async()=>{
    const directory=await mkdtemp(join(tmpdir(),'profread-pdf-history-export-'));directories.push(directory);
    const first=await importSource({buffer:Buffer.from(`<title>Historical PDF ${randomUUID()}</title><p>First HTML version.</p>`),filename:'first.html',mimeType:'text/html'}),documentId=first.documentId!,time=now();documentIds.push(documentId);
    const attach=async(versionId:string,version:number)=>{
      const id=randomUUID(),bytes=Buffer.from(`%PDF-1.7\nImmutable PDF source version ${version}`),path=join(directory,`reading-${version}.pdf`),digest=createHash('sha256').update(bytes).digest('hex');await writeFile(path,bytes);
      db.prepare("INSERT INTO document_representations(id,document_version_id,kind,status,source_hash,source_path,pdf_hash,pdf_path,source_page_start,source_page_end,page_count,created_at,updated_at)VALUES(?,?,'pdf','ready',?,?,?,?,21,21,1,?,?)").run(id,versionId,digest,path,digest,path,time,time);
      return{id,bytes,versionId,version,selector:{kind:'pdf-region',representationId:id,sourceHash:digest,extractionRevision:0,exact:'',segments:[{page:1,quads:[[0,0,50,0,50,10,0,10]]}]}};
    };
    const oldPdf=await attach(first.versionId!,1);
    const oldHtmlId=row<{id:string}>("SELECT id FROM document_representations WHERE document_version_id=? AND kind='html'",first.versionId)!.id;
    let noteVersion=0;
    const addNote=(representationId:string|null,content:string)=>{
      const threadId=randomUUID(),runId=randomUUID();
      db.prepare('INSERT INTO threads(id,document_id,representation_id,created_at,updated_at)VALUES(?,?,?,?,?)').run(threadId,documentId,representationId,time,time);
      db.prepare("INSERT INTO model_runs(id,thread_id,request_id,action,provider_id,model_id,profile,routing_reason,context_tier,status,created_at)VALUES(?,?,?,'ask','test','test','standard','test','canonical','completed',?)").run(runId,threadId,randomUUID(),time);
      db.prepare("INSERT INTO messages(id,thread_id,role,content,model_run_id,created_at)VALUES(?,?,'assistant',?,?,?)").run(randomUUID(),threadId,content,runId,time);
      db.prepare("INSERT INTO artifacts(id,document_version_id,kind,version,scope_type,scope_id,content_json,source_refs_json,promoted,representation_id,created_at)VALUES(?,?,'note',?,'document',?,?,'[]',1,?,?)").run(randomUUID(),first.versionId!,++noteVersion,documentId,JSON.stringify(content),representationId,time);
      return runId;
    };
    addNote(null,'Canonical HTML only');addNote(oldHtmlId,'Bound HTML only');
    const runId=addNote(oldPdf.id,'Original PDF answer [pdf-p21].');
    db.prepare('INSERT INTO source_citations(id,model_run_id,evidence_id,label,selector_json)VALUES(?,?,?,?,?)').run(randomUUID(),runId,'pdf-p21','PDF page 21',JSON.stringify(oldPdf.selector));
    const second=await importSource({documentId,buffer:Buffer.from(`<title>Historical PDF ${randomUUID()}</title><p>Second and current HTML version.</p>`),filename:'second.html',mimeType:'text/html'}),newPdf=await attach(second.versionId!,2);
    const data=await exportData(documentId,true,oldPdf.id);
    expect(data.sourceVersionId).toBe(first.versionId);expect(data.sourceVersion).toBe(1);expect(data.sourceName).toBe('first.html');
    expect(data.artifacts.map(item=>item.content)).toEqual(['Original PDF answer [pdf-p21].']);
    expect(data.messages.map(item=>item.content)).toEqual(['Original PDF answer [pdf-p21].']);
    expect(data.messages[0].sourceCitations[0]).toMatchObject({id:'pdf-p21',selector:oldPdf.selector,citation:'Source PDF page 21 (reader page 1)'});
    for(const rendered of[renderHtml(data),renderMarkdown(data)]){expect(rendered).toContain('[pdf-p21] Source PDF page 21');expect(rendered).not.toContain('HTML only')}
    db.prepare('INSERT INTO document_view_preferences(document_id,representation_id)VALUES(?,?)').run(documentId,oldPdf.id);
    expect((await exportData(documentId,true)).representationId).toBe(oldPdf.id);
    const output=join(directory,'export'),result=await exportLibrary(output,time),manifest=JSON.parse(await readFile(result.manifestPath,'utf8')),entry=manifest.documents.find((item:any)=>item.documentId===documentId);
    expect(entry.files.filter((item:any)=>item.kind==='html-article')).toHaveLength(1);
    expect(entry.files.filter((item:any)=>item.kind==='selected-source-pdf')).toHaveLength(2);
    for(const source of[oldPdf,newPdf]){
      const file=entry.files.find((item:any)=>item.kind==='selected-source-pdf'&&item.representationId===source.id);
      expect(file).toMatchObject({sourceVersionId:source.versionId,sourceVersion:source.version});expect(file.filename).toContain(`PDF v${source.version}`);
      expect(await readFile(join(output,file.filename))).toEqual(source.bytes);
      const notesFile=entry.files.find((item:any)=>item.kind==='pdf-study-data'&&item.representationId===source.id),notes=JSON.parse(await readFile(join(output,notesFile.filename),'utf8'));
      expect(notes).toMatchObject({sourceVersionId:source.versionId,sourceVersion:source.version,representationId:source.id});
      if(source.version===1)expect(notes.messages[0].sourceCitations[0].selector).toEqual(source.selector);
      else expect(notes.messages).toEqual([]);
    }
  });

  it('exports immutable selected/original sources and page-cited study reports without an HTML source',async()=>{
    const directory=await mkdtemp(join(tmpdir(),'profread-pdf-export-'));directories.push(directory);
    const original=Buffer.from('%PDF-1.7\noriginal magazine'),selected=Buffer.from('%PDF-1.7\nselected pages');
    const sourcePath=join(directory,'source.pdf'),pdfPath=join(directory,'reading.pdf');
    await writeFile(sourcePath,original);await writeFile(pdfPath,selected);
    const hash=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
    const documentId=randomUUID(),versionId=randomUUID(),representationId=randomUUID(),anchorId=randomUUID(),time=now();documentIds.push(documentId);
    db.prepare('INSERT INTO documents(id,title,created_at)VALUES(?,?,?)').run(documentId,'Mathematics with AI',time);
    db.prepare("INSERT INTO document_versions(id,document_id,content_hash,source_name,entry_path,sanitized_html_path,canonical_text,token_estimate,version,created_at)VALUES(?,?,?,?,NULL,NULL,'',0,1,?)").run(versionId,documentId,hash(Buffer.from(documentId)),'magazine.pdf',time);
    db.prepare("INSERT INTO document_representations(id,document_version_id,kind,status,source_hash,source_path,pdf_hash,pdf_path,source_page_start,source_page_end,page_count,created_at,updated_at)VALUES(?,?,'pdf','ready',?,?,?,?,21,22,2,?,?)").run(representationId,versionId,hash(original),sourcePath,hash(selected),pdfPath,time,time);
    const selector={kind:'pdf-text',representationId,sourceHash:hash(original),extractionRevision:0,exact:'Mathematical insight',segments:[{page:1,quads:[[0,0,50,0,50,10,0,10]],startOffset:0,endOffset:20,exact:'Mathematical insight'}]};
    db.prepare("INSERT INTO anchors(id,document_version_id,block_id,exact_quote,prefix_text,suffix_text,start_offset,end_offset,block_type,status,representation_id,selector_json,created_at)VALUES(?,?,'',?,'','',0,20,'pdf-text','attached',?,?,?)").run(anchorId,versionId,selector.exact,representationId,JSON.stringify(selector),time);
    db.prepare('INSERT INTO highlights(id,anchor_id,checked,note,created_at,updated_at)VALUES(?,?,1,?,?,?)').run(randomUUID(),anchorId,'Does AI change what insight means?',time,time);
    db.prepare('INSERT INTO threads(id,document_id,anchor_id,title,annotation_text,representation_id,created_at,updated_at)VALUES(?,?,?,?,?,?,?,?)').run(randomUUID(),documentId,anchorId,'Insight','A saved explanation',representationId,time,time);
    const data=await exportData(documentId,false);
    expect(data.sourceKind).toBe('pdf');
    expect(data.highlights[0].citation).toBe('Source PDF page 21 (reader page 1)');
    expect(renderHtml(data)).toContain('Does AI change what insight means?');
    expect(renderHtml(data)).toContain('Source PDF page 21');
    expect(renderMarkdown(data)).toContain('Source PDF page 21');
    expect((await renderPdf(data)).subarray(0,5).toString()).toBe('%PDF-');
    const output=join(directory,'export'),result=await exportLibrary(output,time,{includeOriginalPdfs:true});
    const manifest=JSON.parse(await readFile(result.manifestPath,'utf8')),entry=manifest.documents.find((item:any)=>item.documentId===documentId);
    const file=(kind:string)=>entry.files.find((item:any)=>item.kind===kind).filename;
    expect(await readFile(join(output,file('selected-source-pdf')))).toEqual(selected);
    expect(await readFile(join(output,file('original-source-pdf')))).toEqual(original);
    expect(await readFile(join(output,file('pdf-study-html')),'utf8')).toContain('Source PDF page 21');
    const notes=JSON.parse(await readFile(join(output,file('pdf-study-data')),'utf8'));
    expect(notes.highlights[0].selector).toEqual(selector);
    expect(await readFile(sourcePath)).toEqual(original);
    expect(await readFile(pdfPath)).toEqual(selected);
  });
});
