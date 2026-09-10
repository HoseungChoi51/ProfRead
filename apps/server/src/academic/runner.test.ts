import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { strToU8, zipSync } from 'fflate';
import { afterAll, describe, expect, it } from 'vitest';
import * as cheerio from 'cheerio';
import { buildApp } from '../app.js';
import { config } from '../config.js';
import { db, now, row } from '../db/index.js';
import { extractAcademicBundle, stableAssetId } from './bundle.js';
import { registerAcademicReviewHook, registerAcademicSourceHook } from './runner.js';
import { AcademicWorkerError } from './worker-client.js';

const app=await buildApp();
afterAll(()=>app.close());
let authAttempt=90;

async function authenticatedHeaders(){
  const login=await app.inject({method:'POST',url:'/api/auth/login',remoteAddress:`127.0.1.${++authAttempt}`,payload:{password:'test-owner-password'}});
  return{cookie:login.cookies.map(item=>`${item.name}=${item.value}`).join('; '),'x-csrf-token':login.cookies.find(item=>item.name==='profread_csrf')!.value};
}

function htmlUpload(filename:string,html:string,documentId?:string,aiReviewEnabled=false,autoApply=false):{body:Buffer;contentType:string}{
  const boundary=`afterdraft-${randomUUID()}`,body=Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="sourceKind"\r\n\r\nupload\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="aiReview"\r\n\r\n${JSON.stringify({enabled:aiReviewEnabled,...(autoApply?{autoApply:true}:{})})}\r\n`),
    ...(documentId?[Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="documentId"\r\n\r\n${documentId}\r\n`)]:[]),
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: text/html\r\n\r\n`),
    Buffer.from(html),Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return{body,contentType:`multipart/form-data; boundary=${boundary}`};
}

function docxUpload(source:Buffer):{body:Buffer;contentType:string}{
  const boundary=`afterdraft-${randomUUID()}`,body=Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="sourceKind"\r\n\r\nupload\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="aiReview"\r\n\r\n${JSON.stringify({enabled:false})}\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="paper.docx"\r\nContent-Type: application/vnd.openxmlformats-officedocument.wordprocessingml.document\r\n\r\n`),
    source,Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return{body,contentType:`multipart/form-data; boundary=${boundary}`};
}

function pdfUpload(source:Buffer):{body:Buffer;contentType:string}{
  const boundary=`afterdraft-${randomUUID()}`,body=Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="sourceKind"\r\n\r\npdf\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="aiReview"\r\n\r\n${JSON.stringify({enabled:false,sourceReference:true})}\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="paper.pdf"\r\nContent-Type: application/pdf\r\n\r\n`),
    source,Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return{body,contentType:`multipart/form-data; boundary=${boundary}`};
}

function webUpload(sourceUrl:string):{body:Buffer;contentType:string}{
  const boundary=`afterdraft-${randomUUID()}`,body=Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="sourceKind"\r\n\r\nurl\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="sourceUrl"\r\n\r\n${sourceUrl}\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="aiReview"\r\n\r\n${JSON.stringify({enabled:false})}\r\n`),
    Buffer.from(`--${boundary}--\r\n`),
  ]);
  return{body,contentType:`multipart/form-data; boundary=${boundary}`};
}

function texUpload(source:Buffer):{body:Buffer;contentType:string}{
  const boundary=`afterdraft-${randomUUID()}`,body=Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="sourceKind"\r\n\r\nupload\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="aiReview"\r\n\r\n${JSON.stringify({enabled:false})}\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="paper.tex"\r\nContent-Type: application/x-tex\r\n\r\n`),
    source,Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return{body,contentType:`multipart/form-data; boundary=${boundary}`};
}

function zipUpload(source:Buffer,filename='project.zip'):{body:Buffer;contentType:string}{
  const boundary=`afterdraft-${randomUUID()}`,body=Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="sourceKind"\r\n\r\nupload\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="aiReview"\r\n\r\n${JSON.stringify({enabled:false})}\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/zip\r\n\r\n`),
    source,Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return{body,contentType:`multipart/form-data; boundary=${boundary}`};
}

function workerBundle(sourceHash:string,durationMs:number):Buffer{
  const png=Buffer.from([137,80,78,71,13,10,26,10,0,0,0,0]),files:Record<string,Uint8Array>={
    'document.html':strToU8('<html><head><title>Worker paper</title><link rel="stylesheet" href="assets/site.css"></head><body><p>Converted paper</p><img src="assets/used.png"></body></html>'),
    'assets/site.css':strToU8('.figure{background:url("font.woff2")}'),
    'assets/font.woff2':Buffer.from('wOF2font'),
    'assets/used.png':png,
    'assets/unused.png':png,
    'reference/page-1.png':png,
    'provenance/converter.json':strToU8('{"private":"diagnostic"}'),
  };
  const inventory=Object.entries(files).filter(([path])=>!path.startsWith('provenance/')).map(([path,bytes])=>({path,bytes:bytes.byteLength,sha256:createHash('sha256').update(bytes).digest('hex')}));
  files['manifest.json']=strToU8(JSON.stringify({schemaVersion:1,operation:'convert',source:{kind:'docx',sha256:sourceHash},output:{entryPath:'document.html',title:'Worker paper'},converter:{selected:'pandoc',attempts:[{durationMs}]},warnings:[],files:inventory}));
  return Buffer.from(zipSync(files));
}

async function waitForStatus(jobId:string,status:string):Promise<void>{
  for(let attempt=0;attempt<200;attempt++){
    const current=row<{status:string;error:string|null}>('SELECT status,error FROM import_jobs WHERE id=?',jobId);
    if(current?.status===status)return;
    if(current?.status==='failed')throw new Error(current.error??'Academic import failed');
    await new Promise(resolve=>setTimeout(resolve,10));
  }
  throw new Error(`Timed out waiting for import job ${jobId} to reach ${status}`);
}

describe('academic HTML import lifecycle',()=>{
  it('uploads, previews, and atomically publishes a normalized document',async()=>{
    const headers=await authenticatedHeaders(),marker=randomUUID(),upload=htmlUpload('paper.html',`<!doctype html><html><head><title>Academic ${marker}</title></head><body><h1>Paper</h1><p>Normalized ${marker}</p></body></html>`);
    const created=await app.inject({method:'POST',url:'/api/import-jobs',headers:{...headers,'content-type':upload.contentType},payload:upload.body});
    expect(created.statusCode,created.body).toBe(202);
    const {jobId}=JSON.parse(created.body) as{jobId:string};
    await waitForStatus(jobId,'review-ready');

    const detail=await app.inject({method:'GET',url:`/api/import-jobs/${jobId}`,headers:{cookie:headers.cookie}}),job=JSON.parse(detail.body);
    expect(detail.statusCode).toBe(200);
    expect(job).toMatchObject({status:'review-ready',stage:'review-ready',currentStage:'review',progress:100,callsUsed:0,findingCount:0,warningCount:0,qaStatus:'skipped',aiReview:{enabled:false,sourceReference:false}});
    expect(job.previewUrl).toBe(`/api/import-jobs/${jobId}/preview`);
    expect(job.result.bundleDirectory).toBeUndefined();

    const preview=await app.inject({method:'GET',url:job.previewUrl,headers:{cookie:headers.cookie}});
    expect(preview.statusCode).toBe(200);
    expect(preview.body).toContain(marker);
    expect(preview.body).not.toContain('__PROFREAD_NONCE__');
    expect(preview.headers['content-security-policy']).toContain("default-src 'none'");

    const evidenceDirectory=join(config.dataDir,'imports',jobId,'evidence'),evidencePng=Buffer.from([137,80,78,71,13,10,26,10,0,0,0,0]);await mkdir(evidenceDirectory,{recursive:true});await writeFile(join(evidenceDirectory,'overview.png'),evidencePng);await writeFile(join(evidenceDirectory,'index.json'),JSON.stringify([{id:'overview-test',relativePath:'evidence/overview.png',mimeType:'image/png'},{id:'escape-test',relativePath:'../../outside.png',mimeType:'image/png'}]));
    expect((await app.inject({method:'GET',url:`/api/import-jobs/${jobId}/evidence/overview-test`})).statusCode).toBe(401);
    const evidence=await app.inject({method:'GET',url:`/api/import-jobs/${jobId}/evidence/overview-test`,headers:{cookie:headers.cookie}});expect(evidence.statusCode).toBe(200);expect(evidence.headers['content-type']).toContain('image/png');expect(evidence.headers['cache-control']).toBe('private, no-store');
    expect((await app.inject({method:'GET',url:`/api/import-jobs/${jobId}/evidence/escape-test`,headers:{cookie:headers.cookie}})).statusCode).toBe(404);

    const runId=randomUUID(),findingId=randomUUID(),timestamp=now(),blockId='block-shape-test',privateEvidence=[{id:'overview-test',kind:'object',mimeType:'image/png',storagePath:'/srv/private.png',relativePath:'evidence/overview.png',storage_path:'/snake/private.png',relative_path:'evidence/snake.png',byte_size:99,path:'/secret',bytes:12,content:'private-content',data:'private-data',base64:'private-base64',nested:{path:'/nested-secret',content:'nested-private'}}];db.prepare("INSERT INTO model_runs(id,request_id,action,provider_id,model_id,profile,routing_reason,context_tier,status,created_at)VALUES(?,?,?,?,?,?,?,?,?,?)").run(runId,randomUUID(),'import-visual-audit','openai','gpt-5.6-sol','deep','test','import-evidence','completed',timestamp);db.prepare("INSERT INTO import_findings(id,import_job_id,source,issue_code,severity,title,description,target_ref,evidence_json,decision,model_run_id,created_at,updated_at)VALUES(?,?,'model','table-overflow','warning','Table overflow','Needs review',?,?,'pending',?,?,?)").run(findingId,jobId,blockId,JSON.stringify(privateEvidence),runId,timestamp,timestamp);db.prepare('UPDATE import_jobs SET provenance_json=? WHERE id=?').run(JSON.stringify({qaCoverage:{summary:'All sampled evidence reviewed'}}),jobId);
    const shaped=JSON.parse((await app.inject({method:'GET',url:`/api/import-jobs/${jobId}`,headers:{cookie:headers.cookie}})).body);expect(shaped.coverage).toEqual({summary:'All sampled evidence reviewed'});expect(shaped.findings[0]).toMatchObject({blockId,modelId:'gpt-5.6-sol',evidence:[expect.objectContaining({id:'overview-test',url:`/api/import-jobs/${jobId}/evidence/overview-test`})]});expect(shaped.reviewIssues[0].evidence).toEqual([expect.objectContaining({id:'overview-test',url:`/api/import-jobs/${jobId}/evidence/overview-test`})]);expect(JSON.stringify({findings:shaped.findings,reviewIssues:shaped.reviewIssues})).not.toMatch(/storage_?path|relative_?path|byte_?size|\/srv\/private|\/snake\/private|\/nested-secret|private-content|private-data|private-base64|bytes/);
    db.prepare("UPDATE import_jobs SET status='converting',stage='model-review' WHERE id=?").run(jobId);expect(JSON.parse((await app.inject({method:'GET',url:`/api/import-jobs/${jobId}`,headers:{cookie:headers.cookie}})).body).stage).toBe('ai-review');db.prepare("UPDATE import_jobs SET stage='deterministic-review' WHERE id=?").run(jobId);expect(JSON.parse((await app.inject({method:'GET',url:`/api/import-jobs/${jobId}`,headers:{cookie:headers.cookie}})).body).stage).toBe('validating');db.prepare("UPDATE import_jobs SET status='review-ready',stage='review' WHERE id=?").run(jobId);

    const published=await app.inject({method:'POST',url:`/api/import-jobs/${jobId}/finalize`,headers});
    expect(published.statusCode,published.body).toBe(200);
    const result=JSON.parse(published.body) as{documentId:string;versionId:string;deduplicated:boolean};
    expect(result.deduplicated).toBe(false);
    const stored=row<{status:string;document_id:string;document_version_id:string;sanitized_html_path:string}>('SELECT j.status,j.document_id,j.document_version_id,v.sanitized_html_path FROM import_jobs j JOIN document_versions v ON v.id=j.document_version_id WHERE j.id=?',jobId);
    expect(stored).toMatchObject({status:'published',document_id:result.documentId,document_version_id:result.versionId});
    expect(await readFile(stored!.sanitized_html_path,'utf8')).toContain(marker);
  });

  it('rejects retired automatic repair application without creating a job',async()=>{
    const headers=await authenticatedHeaders(),before=row<{count:number}>('SELECT COUNT(*) count FROM import_jobs')!.count,marker=randomUUID(),upload=htmlUpload(`auto-${marker}.html`,`<title>Auto ${marker}</title><p>Explicit approval is required.</p>`,undefined,true,true),response=await app.inject({method:'POST',url:'/api/import-jobs',headers:{...headers,'content-type':upload.contentType},payload:upload.body});
    expect(response.statusCode,response.body).toBe(400);expect(response.body).toContain('Automatic repair application is retired');expect(row<{count:number}>('SELECT COUNT(*) count FROM import_jobs')!.count).toBe(before);
  });

  it('sniffs, reviews, and publishes a standalone PDF without enabling unused source evidence',async()=>{
    let captured:{source_reference:number;source_mime_type:string}|undefined;
    registerAcademicSourceHook('pdf',async(job,directory)=>{captured={source_reference:job.source_reference,source_mime_type:job.source_mime_type};return extractAcademicBundle(workerBundle(job.source_hash,1),directory,job.source_hash)});
    const headers=await authenticatedHeaders(),invalid=pdfUpload(Buffer.from('not a pdf'));
    const rejected=await app.inject({method:'POST',url:'/api/import-jobs',headers:{...headers,'content-type':invalid.contentType},payload:invalid.body});expect(rejected.statusCode,rejected.body).toBe(400);expect(rejected.body).toContain('not a valid PDF');
    const upload=pdfUpload(Buffer.from('%PDF-1.7\nstandalone-fixture')),created=await app.inject({method:'POST',url:'/api/import-jobs',headers:{...headers,'content-type':upload.contentType},payload:upload.body});expect(created.statusCode,created.body).toBe(202);
    const jobId=JSON.parse(created.body).jobId as string;await waitForStatus(jobId,'review-ready');
    const detail=JSON.parse((await app.inject({method:'GET',url:`/api/import-jobs/${jobId}`,headers:{cookie:headers.cookie}})).body);expect(detail).toMatchObject({sourceKind:'pdf',documentTitle:'Worker paper',qaStatus:'skipped',aiReview:{enabled:false,sourceReference:false}});expect(captured).toEqual({source_reference:0,source_mime_type:'application/pdf'});
    const published=await app.inject({method:'POST',url:`/api/import-jobs/${jobId}/finalize`,headers});expect(published.statusCode,published.body).toBe(200);const result=JSON.parse(published.body);expect(row<{title:string}>('SELECT title FROM documents WHERE id=?',result.documentId)?.title).toBe('Worker paper');
  });

  it('accepts DOI/web jobs but rejects non-HTTPS and credential-bearing locators',async()=>{
    let locator='';registerAcademicSourceHook('url',async(job,directory)=>{locator=(await readFile(job.source_path,'utf8')).trim();return extractAcademicBundle(workerBundle(job.source_hash,1),directory,job.source_hash)});
    const headers=await authenticatedHeaders();
    for(const reference of ['http://publisher.example/paper','https://user:secret@publisher.example/paper','https://publisher.example:8443/paper','https://publisher.example/paper?X-Amz-Signature=secret']){const upload=webUpload(reference),response=await app.inject({method:'POST',url:'/api/import-jobs',headers:{...headers,'content-type':upload.contentType},payload:upload.body});expect(response.statusCode,response.body).toBe(400)}
    const upload=webUpload('10.1515/nanoph-2023-0852'),created=await app.inject({method:'POST',url:'/api/import-jobs',headers:{...headers,'content-type':upload.contentType},payload:upload.body});expect(created.statusCode,created.body).toBe(202);const jobId=JSON.parse(created.body).jobId as string;await waitForStatus(jobId,'review-ready');
    const detail=JSON.parse((await app.inject({method:'GET',url:`/api/import-jobs/${jobId}`,headers:{cookie:headers.cookie}})).body);expect(detail).toMatchObject({sourceKind:'url',sourceName:'10.1515/nanoph-2023-0852',documentTitle:'Worker paper'});expect(locator).toBe('10.1515/nanoph-2023-0852');
    const directPdf=webUpload('https://publisher.example/article/paper.pdf'),direct=await app.inject({method:'POST',url:'/api/import-jobs',headers:{...headers,'content-type':directPdf.contentType},payload:directPdf.body});expect(direct.statusCode,direct.body).toBe(202);const directId=JSON.parse(direct.body).jobId as string;await waitForStatus(directId,'review-ready');expect(locator).toBe('https://publisher.example/article/paper.pdf');
  });

  it('applies an accepted corroborated presentation repair without changing scholarly content',async()=>{
    const headers=await authenticatedHeaders(),marker=randomUUID(),upload=htmlUpload('wide-table.html',`<!doctype html><title>Repair ${marker}</title><h1>Repair paper</h1><p>Prose ${marker}</p><table width="1400" style="width:1400px"><tbody><tr><td>Scholarly cell ${marker}</td></tr></tbody></table><img width="320" src="data:image/png;base64,iVBORw0KGgo=" alt="Layout fixture"><math><mi>x</mi><mo>=</mo><mn>1</mn></math>`),created=await app.inject({method:'POST',url:'/api/import-jobs',headers:{...headers,'content-type':upload.contentType},payload:upload.body});
    expect(created.statusCode,created.body).toBe(202);const jobId=JSON.parse(created.body).jobId as string;await waitForStatus(jobId,'review-ready');
    const previewPath=join(config.dataDir,'imports',jobId,'preview.html'),preview=cheerio.load(await readFile(previewPath,'utf8')),tableId=preview('table[data-block-id]').first().attr('data-block-id')!,imageId=preview('img[data-block-id]').first().attr('data-block-id')!,paragraphId=preview('p[data-block-id]').first().attr('data-block-id')!;
    expect(tableId).toBeTruthy();const timestamp=now(),findingId=randomUUID(),fixedId=randomUUID(),unsafeId=randomUUID();
    db.prepare(`INSERT INTO import_findings(id,import_job_id,source,issue_code,severity,title,description,target_ref,evidence_json,repair_json,confidence,corroborated,decision,created_at,updated_at)
      VALUES(?,?,'model','table-overflow','warning','Wide table','Measured overflow',?,'[]',?,'high',1,'pending',?,?)`).run(findingId,jobId,tableId,JSON.stringify({type:'wrap-overflow',targetRef:tableId}),timestamp,timestamp);
    db.prepare(`INSERT INTO import_findings(id,import_job_id,source,issue_code,severity,title,description,target_ref,evidence_json,repair_json,confidence,corroborated,decision,created_at,updated_at)
      VALUES(?,?,'deterministic','fixed-dimensions','warning','Fixed image dimensions','Bounded presentation repair',?,'[]',?,'high',1,'pending',?,?)`).run(fixedId,jobId,imageId,JSON.stringify({type:'clear-fixed-dimensions',targetRef:imageId}),timestamp,timestamp);
    db.prepare(`INSERT INTO import_findings(id,import_job_id,source,issue_code,severity,title,description,target_ref,evidence_json,repair_json,confidence,corroborated,decision,created_at,updated_at)
      VALUES(?,?,'model','duplicate-content','warning','Unsafe prose repair','Must remain manual',?,'[]',?,'high',1,'pending',?,?)`).run(unsafeId,jobId,paragraphId,JSON.stringify({type:'join-source-fragments',targetRef:paragraphId,sourceRefs:['source-a','source-b']}),timestamp,timestamp);
    const rejected=await app.inject({method:'PATCH',url:`/api/import-jobs/${jobId}/findings/${unsafeId}`,headers,payload:{decision:'accepted'}});expect(rejected.statusCode).toBe(409);
    const detail=JSON.parse((await app.inject({method:'GET',url:`/api/import-jobs/${jobId}`,headers:{cookie:headers.cookie}})).body),issue=detail.reviewIssues.find((item:{findingIds:string[]})=>item.findingIds.includes(findingId)),fixedIssue=detail.reviewIssues.find((item:{findingIds:string[]})=>item.findingIds.includes(fixedId));
    expect(issue).toMatchObject({status:'pending',verificationStatus:'confirmed',repairable:true});expect(fixedIssue).toMatchObject({status:'pending',verificationStatus:'confirmed',repairable:true});
    const prepare=async(issueId:string)=>{const response=await app.inject({method:'POST',url:`/api/import-jobs/${jobId}/repair-batches`,headers,payload:{issueIds:[issueId],strategy:'direct'}});expect(response.statusCode,response.body).toBe(200);return JSON.parse(response.body)};
    const batch=await prepare(issue.id),fixedBatch=await prepare(fixedIssue.id),fixedActivated=await app.inject({method:'POST',url:`/api/import-jobs/${jobId}/repair-batches/${fixedBatch.id}/accept`,headers,payload:{}});expect(fixedActivated.statusCode,fixedActivated.body).toBe(200);
    const rebuilt=await app.inject({method:'POST',url:`/api/import-jobs/${jobId}/repair-batches/${batch.id}/rebuild`,headers,payload:{}});expect(rebuilt.statusCode,rebuilt.body).toBe(200);const replacement=JSON.parse(rebuilt.body);expect(replacement).toMatchObject({status:'draft',baseDerivativeHash:JSON.parse(fixedActivated.body).candidateDerivativeHash});
    expect(JSON.parse((await app.inject({method:'GET',url:`/api/import-jobs/${jobId}/repair-batches/${batch.id}`,headers:{cookie:headers.cookie}})).body).status).toBe('stale');
    const duplicateRebuild=await app.inject({method:'POST',url:`/api/import-jobs/${jobId}/repair-batches/${batch.id}/rebuild`,headers,payload:{}});expect(duplicateRebuild.statusCode,duplicateRebuild.body).toBe(409);expect(row<{count:number}>("SELECT COUNT(*) count FROM import_repair_batches WHERE import_job_id=? AND status='draft'",jobId)?.count).toBe(1);
    expect((await app.inject({method:'GET',url:`/api/import-jobs/${jobId}/repair-batches/${replacement.id}/preview`,headers:{cookie:headers.cookie}})).statusCode).toBe(200);
    const activated=await app.inject({method:'POST',url:`/api/import-jobs/${jobId}/repair-batches/${replacement.id}/accept`,headers,payload:{}});expect(activated.statusCode,activated.body).toBe(200);
    expect((await app.inject({method:'POST',url:`/api/import-jobs/${jobId}/repair-batches/${replacement.id}/rebuild`,headers,payload:{}})).statusCode).toBe(409);
    const published=await app.inject({method:'POST',url:`/api/import-jobs/${jobId}/finalize`,headers});expect(published.statusCode,published.body).toBe(200);const result=JSON.parse(published.body),stored=row<{sanitized_html_path:string}>('SELECT sanitized_html_path FROM document_versions WHERE id=?',result.versionId)!,html=await readFile(stored.sanitized_html_path,'utf8'),$=cheerio.load(html),table=$(`[data-block-id="${tableId}"]`);
    expect(table.attr('data-profread-layout-width')??table.closest('.profread-table-scroll').attr('data-profread-layout-width')).toBe('full');expect(table.text()).toContain(`Scholarly cell ${marker}`);expect($.text()).toContain(`Prose ${marker}`);expect($('math').text()).toContain('x=1');
    expect(row<{applied_at:string|null}>('SELECT applied_at FROM import_findings WHERE id=?',findingId)?.applied_at).toBeNull();
    expect((await app.inject({method:'PATCH',url:`/api/import-jobs/${jobId}/review-issues/${issue.id}`,headers,payload:{decision:'dismissed'}})).statusCode).toBe(409);
  });

  it('never redirects a target-document import to another document with identical content',async()=>{
    const headers=await authenticatedHeaders(),marker=randomUUID();
    const publish=async(upload:ReturnType<typeof htmlUpload>)=>{const created=await app.inject({method:'POST',url:'/api/import-jobs',headers:{...headers,'content-type':upload.contentType},payload:upload.body});expect(created.statusCode,created.body).toBe(202);const jobId=JSON.parse(created.body).jobId as string;await waitForStatus(jobId,'review-ready');const response=await app.inject({method:'POST',url:`/api/import-jobs/${jobId}/finalize`,headers});expect(response.statusCode,response.body).toBe(200);return JSON.parse(response.body) as{documentId:string;versionId:string;deduplicated:boolean}};
    const sharedHtml=`<!doctype html><title>Shared ${marker}</title><h1>Shared</h1><p>Identical ${marker}</p>`,first=await publish(htmlUpload('shared.html',sharedHtml)),target=await publish(htmlUpload('target.html',`<!doctype html><title>Target ${marker}</title><h1>Target</h1><p>Different base ${marker}</p>`));
    const targeted=await publish(htmlUpload('shared.html',sharedHtml,target.documentId));expect(targeted.documentId).toBe(target.documentId);expect(targeted.documentId).not.toBe(first.documentId);expect(targeted.deduplicated).toBe(false);
    const repeated=await publish(htmlUpload('shared.html',sharedHtml,target.documentId));expect(repeated).toMatchObject({documentId:target.documentId,versionId:targeted.versionId,deduplicated:true});
  });

  it('keeps QA evidence quarantined and publishes only document-reachable worker assets',async()=>{
    registerAcademicSourceHook('docx',async(job,directory)=>extractAcademicBundle(workerBundle(job.source_hash,Date.now()),directory,job.source_hash));
    const headers=await authenticatedHeaders(),source=Buffer.from('synthetic-docx-fixture'),upload=docxUpload(source),create=()=>app.inject({method:'POST',url:'/api/import-jobs',headers:{...headers,'content-type':upload.contentType},payload:upload.body});
    const first=await create();expect(first.statusCode,first.body).toBe(202);const firstId=JSON.parse(first.body).jobId as string;await waitForStatus(firstId,'review-ready');
    const firstJob=JSON.parse((await app.inject({method:'GET',url:`/api/import-jobs/${firstId}`,headers:{cookie:headers.cookie}})).body);
    expect(firstJob.result.assets.map((asset:{sourcePath:string})=>asset.sourcePath).sort()).toEqual(['assets/font.woff2','assets/site.css','assets/used.png']);
    expect(firstJob.result.assets).not.toEqual(expect.arrayContaining([expect.objectContaining({sourcePath:'reference/page-1.png'}),expect.objectContaining({sourcePath:'assets/unused.png'}),expect.objectContaining({sourcePath:'provenance/converter.json'})]));

    const cssId=stableAssetId('assets/site.css'),css=await app.inject({method:'GET',url:`/api/import-jobs/${firstId}/assets/${cssId}`,headers:{cookie:headers.cookie}});
    expect(css.statusCode).toBe(200);expect(css.body).toContain(`/api/import-jobs/${firstId}/assets/${stableAssetId('assets/font.woff2')}`);
    expect((await app.inject({method:'GET',url:`/api/import-jobs/${firstId}/assets/${stableAssetId('assets/unused.png')}`,headers:{cookie:headers.cookie}})).statusCode).toBe(404);

    const second=await create();expect(second.statusCode,second.body).toBe(202);const secondId=JSON.parse(second.body).jobId as string;await waitForStatus(secondId,'review-ready');
    const secondJob=JSON.parse((await app.inject({method:'GET',url:`/api/import-jobs/${secondId}`,headers:{cookie:headers.cookie}})).body);
    expect(secondJob.result.derivativeHash).toBe(firstJob.result.derivativeHash);
  });

  it('cancels an active conversion and retries it through the same durable job',async()=>{
    registerAcademicSourceHook('tex',async(_job,_directory,signal)=>new Promise((_resolve,reject)=>{const abort=()=>reject(new Error('cancelled by test'));if(signal.aborted)abort();else signal.addEventListener('abort',abort,{once:true})}));
    const headers=await authenticatedHeaders(),source=Buffer.from('\\documentclass{article}\\begin{document}Test\\end{document}'),upload=texUpload(source),created=await app.inject({method:'POST',url:'/api/import-jobs',headers:{...headers,'content-type':upload.contentType},payload:upload.body});
    expect(created.statusCode,created.body).toBe(202);const jobId=JSON.parse(created.body).jobId as string;await waitForStatus(jobId,'converting');
    const cancelled=await app.inject({method:'POST',url:`/api/import-jobs/${jobId}/cancel`,headers});expect(cancelled.statusCode,cancelled.body).toBe(200);expect(row<{status:string}>('SELECT status FROM import_jobs WHERE id=?',jobId)?.status).toBe('cancelled');

    const staleBundle=join(config.dataDir,'imports',jobId,'bundle-stale'),staleEvidence=join(config.dataDir,'imports',jobId,'evidence');await mkdir(staleBundle,{recursive:true});await mkdir(staleEvidence,{recursive:true});await writeFile(join(staleBundle,'old.html'),'stale');await writeFile(join(staleEvidence,'old.png'),'stale');await writeFile(join(config.dataDir,'imports',jobId,'preview.html'),'stale');
    db.prepare('UPDATE import_jobs SET result_json=?,warnings_json=?,provenance_json=?,call_count=7 WHERE id=?').run('{}','[{}]',JSON.stringify({stale:true}),jobId);
    db.prepare("INSERT INTO import_findings(id,import_job_id,source,issue_code,severity,title,description,evidence_json,decision,created_at,updated_at)VALUES(?,?,'deterministic','stale','warning','Stale','Stale','[]','pending',?,?)").run(randomUUID(),jobId,now(),now());
    registerAcademicSourceHook('tex',async(job,directory)=>extractAcademicBundle(workerBundle(job.source_hash,1),directory,job.source_hash));
    const retried=await app.inject({method:'POST',url:`/api/import-jobs/${jobId}/retry`,headers});expect(retried.statusCode,retried.body).toBe(200);await waitForStatus(jobId,'review-ready');
    await expect(readFile(join(staleBundle,'old.html'))).rejects.toThrow();await expect(readFile(join(staleEvidence,'old.png'))).rejects.toThrow();expect(row<{count:number}>("SELECT COUNT(*) count FROM import_findings WHERE import_job_id=? AND issue_code='stale'",jobId)?.count).toBe(0);
    const list=JSON.parse((await app.inject({method:'GET',url:'/api/import-jobs',headers:{cookie:headers.cookie}})).body) as Array<{id:string;status:string}>;
    expect(list).toEqual(expect.arrayContaining([expect.objectContaining({id:jobId,status:'review-ready'})]));
    const limited=JSON.parse((await app.inject({method:'GET',url:'/api/import-jobs?limit=1',headers:{cookie:headers.cookie}})).body) as unknown[];expect(limited).toHaveLength(1);
  });

  it('keeps cancellation terminal when it arrives during model review',async()=>{
    let entered!:()=>void,aborted!:()=>void;const reviewEntered=new Promise<void>(resolve=>{entered=resolve}),reviewAborted=new Promise<void>(resolve=>{aborted=resolve});
    registerAcademicReviewHook(async({signal})=>{entered();await new Promise<void>(resolve=>{const stop=()=>{aborted();resolve()};if(signal.aborted)stop();else signal.addEventListener('abort',stop,{once:true})});return{status:'completed',callCount:1}});
    const headers=await authenticatedHeaders(),marker=randomUUID(),upload=htmlUpload('cancel-review.html',`<!doctype html><title>Cancel ${marker}</title><p>Review cancellation</p>`,undefined,true),created=await app.inject({method:'POST',url:'/api/import-jobs',headers:{...headers,'content-type':upload.contentType},payload:upload.body});
    expect(created.statusCode,created.body).toBe(202);const jobId=JSON.parse(created.body).jobId as string;await reviewEntered;
    const cancelled=await app.inject({method:'POST',url:`/api/import-jobs/${jobId}/cancel`,headers});expect(cancelled.statusCode,cancelled.body).toBe(200);await reviewAborted;await new Promise(resolve=>setTimeout(resolve,25));
    const stored=row<{status:string;stage:string;progress:number;qa_status:string}>('SELECT status,stage,progress,qa_status FROM import_jobs WHERE id=?',jobId);expect(stored).toMatchObject({status:'cancelled',stage:'cancelled'});expect(stored!.progress).toBeLessThan(1);expect(stored!.qa_status).not.toBe('completed');
  });

  it('keeps ordinary HTML asset ZIPs on the identity HTML path',async()=>{
    const marker=randomUUID(),archive=Buffer.from(zipSync({
      'article/index.html':strToU8(`<html><head><title>HTML ZIP</title><link rel="stylesheet" href="../assets/site.css"></head><body><p>${marker}</p><img src="../assets/figure.png"></body></html>`),
      'assets/site.css':strToU8('img{max-width:100%}'),
      'assets/figure.png':Buffer.from([137,80,78,71,13,10,26,10,0,0,0,0]),
    })),upload=zipUpload(archive,'html-bundle.zip'),headers=await authenticatedHeaders(),created=await app.inject({method:'POST',url:'/api/import-jobs',headers:{...headers,'content-type':upload.contentType},payload:upload.body});
    expect(created.statusCode,created.body).toBe(202);const jobId=JSON.parse(created.body).jobId as string;await waitForStatus(jobId,'review-ready');const detail=JSON.parse((await app.inject({method:'GET',url:`/api/import-jobs/${jobId}`,headers:{cookie:headers.cookie}})).body);
    expect(detail).toMatchObject({sourceKind:'html',status:'review-ready'});expect(detail.result.entryPath).toBe('article/index.html');expect(detail.result.assets.map((asset:{sourcePath:string})=>asset.sourcePath).sort()).toEqual(['assets/figure.png','assets/site.css']);
    const preview=await app.inject({method:'GET',url:detail.previewUrl,headers:{cookie:headers.cookie}});expect(preview.body).toContain(marker);expect(preview.body).toContain(`/api/import-jobs/${jobId}/assets/`);
  });

  it('offers legacy HTML entry choices and resumes the chosen reading page',async()=>{
    const archive=Buffer.from(zipSync({'first.html':strToU8('<title>First</title><p>First article</p>'),'nested/second.html':strToU8('<title>Second</title><p>Chosen second article</p>')})),upload=zipUpload(archive,'multi-html.zip'),headers=await authenticatedHeaders(),created=await app.inject({method:'POST',url:'/api/import-jobs',headers:{...headers,'content-type':upload.contentType},payload:upload.body});
    expect(created.statusCode,created.body).toBe(202);const jobId=JSON.parse(created.body).jobId as string;await waitForStatus(jobId,'failed');const detail=JSON.parse((await app.inject({method:'GET',url:`/api/import-jobs/${jobId}`,headers:{cookie:headers.cookie}})).body);expect(detail).toMatchObject({sourceKind:'html',entryChoices:['first.html','nested/second.html']});
    const cancelled=await app.inject({method:'POST',url:'/api/import-jobs/'+jobId+'/cancel',headers});expect(cancelled.statusCode,cancelled.body).toBe(200);expect(JSON.parse(cancelled.body)).toMatchObject({ok:true,status:'cancelled'});
    expect(row<{status:string;stage:string;error:string|null}>('SELECT status,stage,error FROM import_jobs WHERE id=?',jobId)).toMatchObject({status:'cancelled',stage:'cancelled',error:null});
    const chosen=await app.inject({method:'POST',url:`/api/import-jobs/${jobId}/entry`,headers,payload:{entryPath:'nested/second.html'}});expect(chosen.statusCode,chosen.body).toBe(200);await waitForStatus(jobId,'review-ready');const preview=await app.inject({method:'GET',url:`/api/import-jobs/${jobId}/preview`,headers:{cookie:headers.cookie}});expect(preview.body).toContain('Chosen second article');expect(preview.body).not.toContain('First article');
  });

  it('persists structured TeX ZIP entry choices and resumes with an offered entry',async()=>{
    let selected:string|null=null;registerAcademicSourceHook('tex-zip',async(job,directory)=>{selected=job.entry_path;if(!job.entry_path)throw new AcademicWorkerError('Choose a TeX entry',409,'entry_required',['chapters/main.tex','supplement.tex']);return extractAcademicBundle(workerBundle(job.source_hash,1),directory,job.source_hash)});
    const archive=Buffer.from(zipSync({'chapters/main.tex':strToU8('\\documentclass{article}'),'supplement.tex':strToU8('\\documentclass{article}')})),upload=zipUpload(archive,'tex-project.zip'),headers=await authenticatedHeaders(),created=await app.inject({method:'POST',url:'/api/import-jobs',headers:{...headers,'content-type':upload.contentType},payload:upload.body});
    expect(created.statusCode,created.body).toBe(202);const jobId=JSON.parse(created.body).jobId as string;await waitForStatus(jobId,'failed');const detail=JSON.parse((await app.inject({method:'GET',url:`/api/import-jobs/${jobId}`,headers:{cookie:headers.cookie}})).body);
    expect(detail).toMatchObject({sourceKind:'tex-zip',status:'failed',currentStage:'entry-selection',entryChoices:['chapters/main.tex','supplement.tex']});
    expect((await app.inject({method:'POST',url:`/api/import-jobs/${jobId}/retry`,headers})).statusCode).toBe(409);
    expect((await app.inject({method:'POST',url:`/api/import-jobs/${jobId}/entry`,headers,payload:{entryPath:'not-offered.tex'}})).statusCode).toBe(400);
    const chosen=await app.inject({method:'POST',url:`/api/import-jobs/${jobId}/entry`,headers,payload:{entryPath:'supplement.tex'}});expect(chosen.statusCode,chosen.body).toBe(200);await waitForStatus(jobId,'review-ready');expect(selected).toBe('supplement.tex');
  });
});
