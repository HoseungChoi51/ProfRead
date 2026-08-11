import type { FastifyInstance } from 'fastify';
import { diagramSpecSchema, taskActionSchema, visualRecapSchema, type RunEvent, type ModelProvider, type ModelDefinition } from '@afterdraft/shared';
import { nanoid } from 'nanoid';
import { z } from 'zod';
import { db, now, row, rows } from '../db/index.js';
import { buildContext } from '../models/context.js';
import { ChatCompletionsProvider, ResponsesProvider, generateImageWithResponses } from '../models/providers.js';
import { route, toolsFor } from '../models/router.js';
import { models, profiles, providerSetting, taskModelId } from '../models/settings.js';
import { classifyFreeform } from '../models/classifier.js';
import { deterministicProfile } from '../models/router.js';
import { contractForAction, renderPrompt, requestForAction } from '../models/prompts.js';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from '../config.js';
import { summaryBasis, type SummaryBasis } from './knowledge.js';

const controllers=new Map<string,AbortController>();
const optionalId=z.preprocess(value=>typeof value==='string'&&!value.trim()?undefined:value,z.string().trim().min(1).optional());
const runSchema=z.object({requestId:z.string().min(8).max(128),documentVersionId:z.string().trim().min(1),threadId:optionalId,anchorId:optionalId,artifactScopeType:z.enum(['document','section','answer','thread']).optional(),artifactScopeId:optionalId,action:taskActionSchema,input:z.string().max(20000).default(''),hasVisual:z.boolean().default(false),visual:z.object({mimeType:z.literal('image/png'),data:z.string().max(7_000_000)}).optional(),webEnabled:z.boolean().default(false),modelOverride:z.string().optional()});
const diagramTool={name:'render_diagram',schema:diagramSpecSchema};
type RunInput=z.infer<typeof runSchema>;
const artifactActions=new Set<RunInput['action']>(['summarize','tldr','half-page','visual-recap','compact','visualize']);
type ScopeError={status:400|404;error:string};
type ThreadScope={document_id:string;anchor_id:string|null;parent_message_id:string|null;anchor_document_version_id:string|null;anchor_document_id:string|null};

function validateRunScope(input:RunInput):ScopeError|undefined{
  const version=row<{document_id:string}>('SELECT document_id FROM document_versions WHERE id=?',input.documentVersionId);
  if(!version)return{status:404,error:'Document version not found'};
  const anchor=input.anchorId?row<{document_version_id:string;document_id:string}>('SELECT a.document_version_id,v.document_id FROM anchors a JOIN document_versions v ON v.id=a.document_version_id WHERE a.id=?',input.anchorId):undefined;
  if(input.anchorId&&!anchor)return{status:404,error:'Anchor not found'};
  if(anchor&&anchor.document_version_id!==input.documentVersionId)return{status:400,error:'Anchor does not belong to the requested document version'};
  if(anchor&&anchor.document_id!==version.document_id)return{status:400,error:'Anchor does not belong to the requested document'};
  const thread=input.threadId?threadScope(input.threadId):undefined;
  if(input.threadId&&!thread)return{status:404,error:'Thread not found'};
  if(thread&&thread.document_id!==version.document_id)return{status:400,error:'Thread does not belong to the requested document'};
  if(thread?.anchor_id){
    if(!thread.anchor_document_version_id||!thread.anchor_document_id||thread.anchor_document_id!==thread.document_id)return{status:400,error:'Thread anchor does not belong to its document'};
    if(thread.anchor_document_version_id!==input.documentVersionId)return{status:400,error:'Thread anchor does not belong to the requested document version'};
    if(input.anchorId!==thread.anchor_id)return{status:400,error:'Run anchor does not match the thread anchor'};
  }else if(thread&&input.anchorId)return{status:400,error:'Run anchor does not match the anchor-less thread'};
  if(thread){const lineageError=validateThreadLineage(input.threadId!,thread,version.document_id);if(lineageError)return lineageError;}
  if(Boolean(input.artifactScopeType)!==Boolean(input.artifactScopeId))return{status:400,error:'Artifact scope type and ID must be provided together'};
  if(artifactActions.has(input.action)&&!input.artifactScopeType)return{status:400,error:'Artifact-producing actions require an explicit scope'};
  if(!input.artifactScopeType||!input.artifactScopeId)return;
  if(input.artifactScopeType==='document'&&input.artifactScopeId!==version.document_id)return{status:400,error:'Document artifact scope does not match the requested document'};
  if(input.artifactScopeType==='section'){
    const scopeAnchor=input.artifactScopeId===input.anchorId?anchor:row<{document_version_id:string;document_id:string}>('SELECT a.document_version_id,v.document_id FROM anchors a JOIN document_versions v ON v.id=a.document_version_id WHERE a.id=?',input.artifactScopeId);
    if(!scopeAnchor)return{status:404,error:'Section artifact anchor not found'};
    if(scopeAnchor.document_version_id!==input.documentVersionId||scopeAnchor.document_id!==version.document_id)return{status:400,error:'Section artifact scope does not belong to the requested document version'};
    if(input.anchorId!==input.artifactScopeId)return{status:400,error:'Section artifact scope does not match the run anchor'};
  }
  if(input.artifactScopeType==='thread'){
    const scopeThread=input.artifactScopeId===input.threadId?thread:threadScope(input.artifactScopeId);
    if(!scopeThread)return{status:404,error:'Thread artifact scope not found'};
    if(scopeThread.document_id!==version.document_id)return{status:400,error:'Thread artifact scope does not belong to the requested document'};
    if(input.threadId!==input.artifactScopeId)return{status:400,error:'Thread artifact scope does not match the run thread'};
  }
  if(input.artifactScopeType==='answer'){
    const answer=row<{thread_id:string;document_id:string}>('SELECT m.thread_id,t.document_id FROM messages m JOIN threads t ON t.id=m.thread_id WHERE m.id=?',input.artifactScopeId);
    if(!answer)return{status:404,error:'Answer artifact message not found'};
    if(answer.document_id!==version.document_id)return{status:400,error:'Answer artifact scope does not belong to the requested document'};
    if(thread&&answer.thread_id!==input.threadId&&thread.parent_message_id!==input.artifactScopeId)return{status:400,error:'Answer artifact scope does not match the run thread'};
  }
}

function threadScope(threadId:string):ThreadScope|undefined{return row<ThreadScope>(`SELECT t.document_id,t.anchor_id,t.parent_message_id,a.document_version_id anchor_document_version_id,v.document_id anchor_document_id
  FROM threads t LEFT JOIN anchors a ON a.id=t.anchor_id LEFT JOIN document_versions v ON v.id=a.document_version_id WHERE t.id=?`,threadId)}
function validateThreadLineage(threadId:string,thread:ThreadScope,documentId:string):ScopeError|undefined{
  const seen=new Set<string>();let currentId=threadId,current=thread;
  while(current.parent_message_id){
    if(seen.has(currentId))return{status:400,error:'Thread ancestry contains a cycle'};seen.add(currentId);
    const parent=row<{thread_id:string;document_id:string}>('SELECT m.thread_id,t.document_id FROM messages m JOIN threads t ON t.id=m.thread_id WHERE m.id=?',current.parent_message_id);
    if(!parent)return{status:400,error:'Thread parent message was not found'};
    if(parent.document_id!==documentId)return{status:400,error:'Thread ancestry does not belong to the requested document'};
    const parentThread=threadScope(parent.thread_id);if(!parentThread)return{status:400,error:'Thread parent was not found'};currentId=parent.thread_id;current=parentThread;
  }
}

export function registerRunRoutes(app:FastifyInstance):void {
  app.post('/api/routing/preview',async(request,reply)=>{const parsed=runSchema.omit({requestId:true,threadId:true,anchorId:true}).safeParse(request.body);if(!parsed.success)return reply.code(400).send({error:parsed.error.flatten()});const input=parsed.data,availableModels=models(),availableProfiles=profiles(),configuredModel=taskModelId(input.action),routeInput={action:input.action,input:input.input,hasVisual:input.hasVisual,webEnabled:input.webEnabled,estimatedTokens:row<{token_estimate:number}>('SELECT token_estimate FROM document_versions WHERE id=?',input.documentVersionId)?.token_estimate??0,...(input.modelOverride?{modelOverride:input.modelOverride}:configuredModel?{taskModelId:configuredModel}:{})};try{const classified=deterministicProfile(routeInput)?undefined:input.input.length>120?'deep':'standard',decision=route(routeInput,availableModels,availableProfiles,{},classified);return{modelId:decision.model.id,providerId:decision.model.providerId,profile:decision.profile,reason:decision.reason,enabledTools:toolsFor(input)}}catch(error){return reply.code(422).send({error:(error as Error).message})}});
  app.post('/api/runs',async(request,reply)=>{
    const parsed=runSchema.safeParse(request.body);if(!parsed.success)return reply.code(400).send({error:parsed.error.flatten()});const input=parsed.data;
    if(input.action==='polish-note'&&(!input.threadId||!input.input.trim()||input.input.trim().length>500))return reply.code(400).send({error:'Polish annotation requires a thread and a draft of 1 to 500 characters'});
    const scopeError=validateRunScope(input);if(scopeError)return reply.code(scopeError.status).send({error:scopeError.error});
    const previous=row<{id:string;status:string;provider_id:string;model_id:string;profile:string;routing_reason:string;context_tier:string;response_text:string|null;error:string|null}>('SELECT * FROM model_runs WHERE request_id=?',input.requestId);if(previous){if(previous.status==='running')return reply.code(409).send({error:'Identical request is already running',runId:previous.id,status:previous.status});reply.hijack();reply.raw.statusCode=200;reply.raw.setHeader('content-type','text/event-stream; charset=utf-8');reply.raw.setHeader('cache-control','no-cache, no-transform');reply.raw.write(`event: route\ndata: ${JSON.stringify({runId:previous.id,modelId:previous.model_id,providerId:previous.provider_id,profile:previous.profile,reason:previous.routing_reason,contextTier:previous.context_tier,replayed:true})}\n\n`);if(previous.response_text)reply.raw.write(`event: text_delta\ndata: ${JSON.stringify({type:'text_delta',delta:previous.response_text,replayed:true})}\n\n`);const event=previous.status==='completed'?'done':previous.status==='cancelled'?'cancelled':'error';reply.raw.write(`event: ${event}\ndata: ${JSON.stringify({runId:previous.id,message:previous.error,replayed:true})}\n\n`);reply.raw.end();return}
    const availableModels=models(),availableProfiles=profiles(),configuredModel=taskModelId(input.action),routeInput={action:input.action,input:input.input,hasVisual:input.hasVisual,webEnabled:input.webEnabled,estimatedTokens:row<{token_estimate:number}>('SELECT token_estimate FROM document_versions WHERE id=?',input.documentVersionId)?.token_estimate??0,...(input.modelOverride?{modelOverride:input.modelOverride}:configuredModel?{taskModelId:configuredModel}:{})};const classified=input.modelOverride||configuredModel||deterministicProfile(routeInput)?undefined:await classifyFreeform(input.input,availableModels,availableProfiles);
    let decision;try{decision=route(routeInput,availableModels,availableProfiles,Object.fromEntries(rows<{model_id:string;avg:number}>('SELECT model_id,AVG(ttft_ms) avg FROM model_runs WHERE status=\'completed\' AND ttft_ms IS NOT NULL GROUP BY model_id').map(r=>[r.model_id,r.avg])),classified);}catch(error){return reply.code(422).send({error:error instanceof Error?error.message:'Routing failed'});}
    const routedModel=decision.model;let setting:ReturnType<typeof providerSetting>,apiKey:string|undefined;for(const candidate of decision.eligible){const candidateSetting=providerSetting(candidate.providerId),candidateKey=candidateSetting?.enabled?process.env[candidateSetting.secret_env_name]:undefined;if(candidateSetting&&candidateKey){decision.model=candidate;setting=candidateSetting;apiKey=candidateKey;break}}if(!setting||!apiKey)return reply.code(422).send({error:'No eligible model has an enabled provider with a configured server secret'});
    const context=buildContext(input.documentVersionId,decision.profile,input.anchorId,input.threadId,decision.model.contextWindow),summaryRunBasis=input.artifactScopeType==='document'&&['summarize','tldr','half-page','visual-recap'].includes(input.action)?summaryBasis(input.documentVersionId):undefined;const enabledTools=toolsFor(input);const runId=nanoid(),created=now();
    db.prepare(`INSERT INTO model_runs(id,thread_id,request_id,action,provider_id,model_id,profile,routing_reason,context_tier,fallback_model_id,status,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,'running',?)`).run(runId,input.threadId??null,input.requestId,input.action,decision.model.providerId,decision.model.id,decision.profile,decision.reason,context.tier,decision.model.id===routedModel.id?null:decision.model.id,created);let attemptId=nanoid();db.prepare(`INSERT INTO model_attempts(id,model_run_id,model_id,provider_id,attempt,status,started_at)VALUES(?,?,?,?,1,'running',?)`).run(attemptId,runId,decision.model.id,decision.model.providerId,created);
    const controller=new AbortController();controllers.set(runId,controller);reply.hijack();reply.raw.statusCode=200;reply.raw.setHeader('content-type','text/event-stream; charset=utf-8');reply.raw.setHeader('cache-control','no-cache, no-transform');reply.raw.setHeader('connection','keep-alive');reply.raw.flushHeaders();
    const send=(event:string,data:unknown)=>reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);send('route',{runId,modelId:decision.model.id,providerId:decision.model.providerId,profile:decision.profile,reason:decision.reason,contextTier:context.tier,enabledTools});
    const requestText=requestForAction(input.action,input.input,input.artifactScopeType),contract=contractForAction(input.action);
    const prompt=renderPrompt('user.envelope',{
      contextTier:context.tier,
      articleContext:context.article,
      selectedAnchor:context.anchor??'(none)',
      neighboringBlock:context.neighboringBlock??'(none)',
      discussionBranch:context.branch.map(message=>`${message.role}: ${message.content}`).join('\n'),
      curatedNotes:context.curatedNotes.join('\n'),
      action:input.action,
      request:requestText,
      contract,
    });
    let provider:ModelProvider=createProvider(decision.model,apiKey,setting.base_url,setting.config_json);const previousResponseId=input.threadId&&decision.model.protocol==='openai-responses'?row<{provider_response_id:string}>('SELECT provider_response_id FROM model_runs WHERE thread_id=? AND provider_id=? AND model_id=? AND action<>\'polish-note\' AND status=\'completed\' AND provider_response_id IS NOT NULL ORDER BY completed_at DESC LIMIT 1',input.threadId,decision.model.providerId,decision.model.id)?.provider_response_id:undefined;
    let image:{mimeType:string;data:string}|undefined;if(input.visual){const bytes=Buffer.from(input.visual.data,'base64');if(bytes.length<=5_000_000&&bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))image=input.visual}if(!image&&input.hasVisual&&input.anchorId){const visual=row<{visual_data:string}>('SELECT b.visual_data FROM anchors a JOIN blocks b ON b.id=a.block_id AND b.document_version_id=a.document_version_id WHERE a.id=?',input.anchorId)?.visual_data;if(visual?.startsWith('/api/assets/')){const assetId=visual.split('/').pop();const asset=assetId?row<{mime_type:string;storage_path:string}>('SELECT mime_type,storage_path FROM assets WHERE id=?',assetId):undefined;if(asset)image={mimeType:asset.mime_type,data:(await readFile(asset.storage_path)).toString('base64')}}else if(visual?.startsWith('<svg'))image={mimeType:'image/svg+xml',data:Buffer.from(visual).toString('base64')}}
    let answer='',first=0,inputTokens=0,outputTokens=0,providerResponseId:string|undefined,diagram:unknown;const started=Date.now();
    const runTools=[...(enabledTools.includes('render_diagram')?[diagramTool]:[]),...(enabledTools.includes('provider_web_search')?[{name:'provider_web_search',schema:{}}]:[])];
    try{const candidates=[decision.model,...decision.eligible.filter(model=>model.id!==decision.model.id)];let succeeded=false;for(let index=0;index<candidates.length;index++){const candidate=candidates[index]!,candidateSetting=providerSetting(candidate.providerId),candidateKey=candidateSetting?.enabled?process.env[candidateSetting.secret_env_name]:undefined;if(!candidateSetting||!candidateKey)continue;if(index>0){decision.model=candidate;provider=createProvider(candidate,candidateKey,candidateSetting.base_url,candidateSetting.config_json);attemptId=nanoid();db.prepare(`INSERT INTO model_attempts(id,model_run_id,model_id,provider_id,attempt,status,started_at)VALUES(?,?,?,?,?,'running',?)`).run(attemptId,runId,candidate.id,candidate.providerId,index+1,now());db.prepare('UPDATE model_runs SET fallback_model_id=? WHERE id=?').run(candidate.id,runId);send('fallback',{modelId:candidate.id,providerId:candidate.providerId,reason:'previous eligible model failed before producing output'})}let emitted=false;try{for await(const event of provider.run({model:decision.model,messages:[{role:'system',content:renderPrompt('system.reading-partner')},{role:'user',content:prompt}],...(runTools.length?{tools:runTools}:{}),...(image?{image}:{}),...(previousResponseId&&index===0?{previousResponseId}:{}),signal:controller.signal})){
      let outgoing=event;
      if(event.type==='text_delta'){
        const delta=input.action==='polish-note'?event.delta.slice(0,Math.max(0,500-answer.length)):event.delta;
        if(!delta)continue;
        if(!first)first=Date.now();answer+=delta;emitted=true;outgoing={...event,delta};
      }
      if(event.type==='completed'&&event.responseId)providerResponseId=event.responseId;
      if(event.type==='tool_call'){emitted=true;if(event.name==='render_diagram'){try{diagram=diagramSpecSchema.parse(typeof event.input==='string'?JSON.parse(event.input):event.input)}catch{/* invalid output remains a recorded tool event */}}}
      if(event.type==='usage'){inputTokens=event.inputTokens;outputTokens=event.outputTokens;}
      persistEvent(runId,outgoing);send(outgoing.type,outgoing);
    }succeeded=true;break}catch(error){const message=error instanceof Error?error.message:String(error);db.prepare(`UPDATE model_attempts SET status='failed',error=?,completed_at=? WHERE id=?`).run(message,now(),attemptId);if(emitted||controller.signal.aborted||index===candidates.length-1)throw error}}if(!succeeded)throw new Error('No configured fallback model could run this request');
      let visualRecap:unknown;if(input.action==='visual-recap'){try{visualRecap=visualRecapSchema.parse(parseJson(answer))}catch{send('schema_repair',{attempt:1});try{const repaired=await collectText(provider,decision.model,renderPrompt('visual-recap.repair',{invalidOutput:answer}),controller.signal);visualRecap=visualRecapSchema.parse(parseJson(repaired))}catch{visualRecap=undefined}}if(visualRecap){if(decision.model.protocol!=='openai-responses')throw new Error('Visual recap images require an OpenAI Responses model');const selectedSetting=providerSetting(decision.model.providerId),selectedKey=selectedSetting?.enabled?process.env[selectedSetting.secret_env_name]:undefined;if(!selectedSetting||!selectedKey)throw new Error('The selected image model provider is not ready');send('image_generation',{status:'started',modelId:decision.model.id});const recap=visualRecapSchema.parse(visualRecap),imageData=await generateImageWithResponses(selectedKey,decision.model.id,renderPrompt('visual-recap.image',{visualRecapJson:JSON.stringify(recap)}),selectedSetting.base_url,controller.signal),bytes=Buffer.from(imageData,'base64');if(bytes.length>25_000_000||!bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))throw new Error('Image generation returned invalid PNG data');const imageId=nanoid();await writeFile(join(config.dataDir,'generated',`${imageId}.png`),bytes,{flag:'wx'});visualRecap=visualRecapSchema.parse({...recap,image:{url:`/api/generated/${imageId}.png`,alt:`Visual recap of ${recap.title}`,modelId:decision.model.id}});send('image_generated',{url:`/api/generated/${imageId}.png`,modelId:decision.model.id});}}
      const completed=now(),artifactScopeId=input.artifactScopeId??input.threadId??runId,artifactScopeType=input.artifactScopeType??'thread';db.prepare(`UPDATE model_runs SET status='completed',ttft_ms=?,latency_ms=?,input_tokens=?,output_tokens=?,provider_response_id=?,response_text=?,completed_at=? WHERE id=?`).run(first?first-started:null,Date.now()-started,inputTokens,outputTokens,providerResponseId??null,answer||null,completed,runId);db.prepare(`UPDATE model_attempts SET status='completed',completed_at=? WHERE id=?`).run(completed,attemptId);let messageId:string|undefined;if(input.threadId&&answer&&input.action!=='polish-note'){messageId=nanoid();db.prepare('INSERT INTO messages(id,thread_id,role,content,created_at) VALUES(?,?,?,?,?)').run(messageId,input.threadId,'assistant',answer,completed);db.prepare(`INSERT INTO search_index(kind,entity_id,document_id,title,body,tags,model_id,created_at) SELECT 'answer',?,document_id,'',?,'',?,? FROM threads WHERE id=?`).run(messageId,answer,decision.model.id,completed,input.threadId);}if((input.action==='summarize'||input.action==='tldr')&&answer)saveArtifact(input.documentVersionId,'tldr',artifactScopeId,limitTldr(answer),[input.anchorId??input.artifactScopeId??input.documentVersionId],decision.model.id,artifactScopeType,summaryRunBasis);if(input.action==='half-page'&&answer)saveArtifact(input.documentVersionId,'half-page',artifactScopeId,answer,[input.anchorId??input.artifactScopeId??input.documentVersionId],decision.model.id,artifactScopeType,summaryRunBasis);if(input.action==='compact'&&answer)saveArtifact(input.documentVersionId,'compact',artifactScopeId,answer,[input.anchorId??input.artifactScopeId??input.documentVersionId],decision.model.id,artifactScopeType);if(input.action==='visual-recap'&&visualRecap)saveArtifact(input.documentVersionId,'visual-recap',artifactScopeId,visualRecap,[input.anchorId??input.artifactScopeId??input.documentVersionId],decision.model.id,artifactScopeType,summaryRunBasis);else if(input.action==='visual-recap'&&answer)saveArtifact(input.documentVersionId,'compact',artifactScopeId,answer,[input.anchorId??input.artifactScopeId??input.documentVersionId],decision.model.id,artifactScopeType);if(diagram)saveArtifact(input.documentVersionId,'diagram',artifactScopeId,diagram,[input.anchorId??input.artifactScopeId??input.documentVersionId],decision.model.id,artifactScopeType);send('done',{runId});
    }catch(error){const cancelled=controller.signal.aborted,errorMessage=error instanceof Error?error.message:String(error);db.prepare('UPDATE model_runs SET status=?,latency_ms=?,error=?,completed_at=? WHERE id=?').run(cancelled?'cancelled':'failed',Date.now()-started,errorMessage,now(),runId);db.prepare('UPDATE model_attempts SET status=?,error=?,completed_at=? WHERE id=?').run(cancelled?'cancelled':'failed',errorMessage,now(),attemptId);send(cancelled?'cancelled':'error',{message:cancelled?'Cancelled':error instanceof Error?error.message:'Run failed'});}finally{controllers.delete(runId);reply.raw.end();}
  });
  app.post('/api/runs/:id/cancel',async(request,reply)=>{const id=(request.params as {id:string}).id;const controller=controllers.get(id);if(!controller)return reply.code(404).send({error:'Active run not found'});controller.abort();return {ok:true};});
  app.get('/api/runs/:id',async(request,reply)=>{const run=row('SELECT * FROM model_runs WHERE id=?',(request.params as {id:string}).id);return run??reply.code(404).send({error:'Run not found'});});
}
function persistEvent(runId:string,event:RunEvent):void{if(event.type==='citation')db.prepare('INSERT INTO citations(id,model_run_id,title,url,start_offset,end_offset) VALUES(?,?,?,?,?,?)').run(event.citation.id,runId,event.citation.title??null,event.citation.url,event.citation.start??null,event.citation.end??null);if(event.type==='tool_call'||event.type==='tool_result')db.prepare('INSERT INTO tool_events(id,model_run_id,event_type,tool_name,payload_json,created_at) VALUES(?,?,?,?,?,?)').run(nanoid(),runId,event.type,event.type==='tool_call'?event.name:'result',JSON.stringify(event),now());}
function limitTldr(text:string):string{const words=text.split(/\s+/).filter(Boolean);return words.length<=150?text:words.slice(0,150).join(' ')+'…'}
function saveArtifact(versionId:string,kind:string,scopeId:string,content:unknown,sourceRefs:string[],modelId:string,scopeType:'document'|'section'|'answer'|'thread'='thread',summaryRunBasis?:SummaryBasis){
  const singleton=kind==='tldr'||kind==='half-page'||kind==='visual-recap';
  const existing=singleton?row<{id:string;version:number}>('SELECT id,version FROM artifacts WHERE kind=? AND scope_type=? AND scope_id=? ORDER BY version DESC LIMIT 1',kind,scopeType,scopeId):undefined;
  const version=existing?.version??(row<{next:number}>('SELECT COALESCE(MAX(version),0)+1 next FROM artifacts WHERE kind=? AND scope_type=? AND scope_id=?',kind,scopeType,scopeId)?.next??1),id=existing?.id??nanoid(),time=now();
  const basis=singleton&&scopeType==='document'?summaryRunBasis:undefined;
  if(existing)db.prepare('UPDATE artifacts SET document_version_id=?,content_json=?,source_refs_json=?,basis_document_version_id=?,basis_revision=?,basis_signal_hash=?,created_at=? WHERE id=?').run(versionId,JSON.stringify(content),JSON.stringify(sourceRefs),basis?.documentVersionId??null,basis?.revision??null,basis?.signalHash??null,time,id);
  else db.prepare('INSERT INTO artifacts(id,document_version_id,kind,version,scope_type,scope_id,content_json,source_refs_json,promoted,basis_document_version_id,basis_revision,basis_signal_hash,created_at)VALUES(?,?,?,?,?,?,?,?,0,?,?,?,?)').run(id,versionId,kind,version,scopeType,scopeId,JSON.stringify(content),JSON.stringify(sourceRefs),basis?.documentVersionId??null,basis?.revision??null,basis?.signalHash??null,time);
  const documentId=row<{document_id:string}>('SELECT document_id FROM document_versions WHERE id=?',versionId)?.document_id??'';
  if(existing)db.prepare('DELETE FROM search_index WHERE kind=\'artifact\' AND entity_id=?').run(id);
  db.prepare('INSERT INTO search_index(kind,entity_id,document_id,title,body,tags,model_id,created_at)VALUES(?,?,?,?,?,?,?,?)').run('artifact',id,documentId,kind,typeof content==='string'?content:JSON.stringify(content),'',modelId,time);
}
function parseJson(text:string):unknown{return JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g,''))}
async function collectText(provider:ModelProvider,model:ModelDefinition,prompt:string,signal:AbortSignal):Promise<string>{let text='';for await(const event of provider.run({model,messages:[{role:'user',content:prompt}],signal}))if(event.type==='text_delta')text+=event.delta;return text}
function createProvider(model:ModelDefinition,key:string,baseUrl:string,configJson='{}'):ModelProvider{let config:Record<string,unknown>={};try{config=JSON.parse(configJson)}catch{/* settings validation will surface malformed JSON elsewhere */}return model.protocol==='openai-responses'?new ResponsesProvider(key,[model],baseUrl):new ChatCompletionsProvider(key,[model],baseUrl,model.protocol==='openrouter',config.provider&&typeof config.provider==='object'?config.provider as Record<string,unknown>:undefined)}
