import {
  importAuditReportSchema,
  importAuditToolName,
  type ImportAuditReport,
  type ModelDefinition,
  type ModelProvider,
  type TaskAction,
} from '@afterdraft/shared';
import { createHash } from 'node:crypto';
import { nanoid } from 'nanoid';
import { db, now, row } from '../db/index.js';
import { ChatCompletionsProvider, ResponsesProvider } from './providers.js';
import { promptTemplate, renderPrompt } from './prompts.js';
import { route } from './router.js';
import { models, profiles, providerSetting, taskModelId } from './settings.js';

export type ImportAuditAction = Extract<TaskAction,
  'import-triage'|'import-semantic-audit'|'import-visual-audit'|'import-adjudicate'|'import-verify-repair'>;

export type ImportAuditEvidenceImage = {
  id: string;
  mimeType: 'image/png'|'image/jpeg'|'image/webp';
  data: string;
  detail?: 'low'|'high'|'original'|'auto';
};

export type ImportAuditRequest = {
  jobId: string;
  ordinal: number;
  action: ImportAuditAction;
  promptValues: Record<string,string>;
  evidenceRefs: string[];
  targetRefs: string[];
  images?: ImportAuditEvidenceImage[];
  signal?: AbortSignal;
};

export type ImportAuditResult = {
  report: ImportAuditReport;
  runId: string;
  modelId: string;
  inputTokens: number;
  outputTokens: number;
};

const promptKey: Record<ImportAuditAction,string> = {
  'import-triage':'import.triage',
  'import-semantic-audit':'import.semantic-audit',
  'import-visual-audit':'import.visual-audit',
  'import-adjudicate':'import.adjudicate',
  'import-verify-repair':'import.verify-repair',
};

const stringSchema = { type:'string' } as const;
const stringArray = (maxItems:number,minItems=0) => ({ type:'array',items:stringSchema,minItems,maxItems } as const);
const strictObject = (properties:Record<string,unknown>) => ({ type:'object',properties,required:Object.keys(properties),additionalProperties:false } as const);
const target = stringSchema;
const repairSchema = { anyOf:[
  { type:'null' },
  strictObject({type:{type:'string',enum:['set-object-layout']},targetRef:target,width:{type:'string',enum:['auto','content','full']},alignment:{type:'string',enum:['left','center','right']},enlargeable:{type:'boolean'}}),
  strictObject({type:{type:'string',enum:['wrap-overflow']},targetRef:target}),
  strictObject({type:{type:'string',enum:['clear-fixed-dimensions']},targetRef:target}),
  strictObject({type:{type:'string',enum:['join-source-fragments']},targetRef:target,sourceRefs:stringArray(4,2)}),
  strictObject({type:{type:'string',enum:['suppress-source-chrome']},targetRef:target,sourceRef:target}),
  strictObject({type:{type:'string',enum:['associate-caption']},targetRef:target,captionRef:target}),
  strictObject({type:{type:'string',enum:['move-object']},targetRef:target,destinationRef:target,position:{type:'string',enum:['before','after']}}),
  strictObject({type:{type:'string',enum:['set-semantic-role']},targetRef:target,role:{type:'string',enum:['title','author','affiliation','abstract','keywords','heading','caption','body']}}),
  strictObject({type:{type:'string',enum:['draft-alt-text']},targetRef:target,text:stringSchema}),
] } as const;

export const importAuditTool = { name:importAuditToolName,schema:strictObject({
  version:{type:'integer',enum:[1]},
  verdict:{type:'string',enum:['clean','review','blocking']},
  coverage:strictObject({reviewedRefs:stringArray(500),unreviewedRefs:stringArray(500)}),
  findings:{type:'array',maxItems:200,items:strictObject({
    issueCode:{type:'string',enum:['missing-content','duplicate-content','broken-reading-order','front-matter','caption-association','figure-missing','figure-cropped','table-overflow','equation-degraded','citation-mismatch','template-chrome','raw-field-leak','unreadable-layout','responsive-regression','missing-alt-text']},
    severity:{type:'string',enum:['info','warning','error']},
    evidenceRefs:stringArray(20,1),
    targetRefs:stringArray(20),
    observation:stringSchema,
    sourceComparison:stringSchema,
    confidence:{type:'string',enum:['low','medium','high']},
    suggestedRepair:repairSchema,
    requestedEvidenceRefs:stringArray(20),
  })},
}) } as const;

function parseToolInput(value:unknown): ImportAuditReport {
  if (typeof value === 'string') {
    try { return importAuditReportSchema.parse(JSON.parse(value)); }
    catch (error) { if (error instanceof SyntaxError) throw new Error('Import auditor returned invalid JSON'); throw error; }
  }
  return importAuditReportSchema.parse(value);
}

function assertUniqueKnownRefs(label:string,refs:string[],allowed:Set<string>):void {
  if (new Set(refs).size !== refs.length) throw new Error(`Import auditor returned duplicate ${label} references`);
  const unknown = refs.find(ref => !allowed.has(ref));
  if (unknown) throw new Error(`Import auditor returned an unknown ${label} reference: ${unknown}`);
}

export function validateImportAuditReport(value:unknown,evidenceRefs:Iterable<string>,targetRefs:Iterable<string>):ImportAuditReport {
  const report=parseToolInput(value),evidence=new Set(evidenceRefs),targets=new Set(targetRefs),all=new Set([...evidence,...targets]);
  assertUniqueKnownRefs('reviewed evidence',report.coverage.reviewedRefs,evidence);
  assertUniqueKnownRefs('unreviewed evidence',report.coverage.unreviewedRefs,evidence);
  const covered=new Set([...report.coverage.reviewedRefs,...report.coverage.unreviewedRefs]);
  if(covered.size!==evidence.size)throw new Error('Import auditor coverage does not account for every supplied evidence reference');
  for(const finding of report.findings){
    assertUniqueKnownRefs('finding evidence',finding.evidenceRefs,evidence);
    assertUniqueKnownRefs('finding target',finding.targetRefs,targets);
    assertUniqueKnownRefs('requested evidence',finding.requestedEvidenceRefs,evidence);
    const repair=finding.suggestedRepair;if(!repair)continue;
    if(!targets.has(repair.targetRef))throw new Error(`Import auditor repair targets an unknown reference: ${repair.targetRef}`);
    if(finding.targetRefs.length&&!finding.targetRefs.includes(repair.targetRef))throw new Error('Import auditor repair target is not declared by its finding');
    if(repair.type==='join-source-fragments')assertUniqueKnownRefs('source fragment',repair.sourceRefs,all);
    if(repair.type==='suppress-source-chrome'&&!all.has(repair.sourceRef))throw new Error(`Import auditor returned an unknown source reference: ${repair.sourceRef}`);
    if(repair.type==='associate-caption'&&!targets.has(repair.captionRef))throw new Error(`Import auditor returned an unknown caption reference: ${repair.captionRef}`);
    if(repair.type==='move-object'&&!targets.has(repair.destinationRef))throw new Error(`Import auditor returned an unknown destination reference: ${repair.destinationRef}`);
  }
  return report;
}

export function mayAutoApplyImportRepair(finding:ImportAuditReport['findings'][number],deterministicallyCorroborated:boolean):boolean{
  if(finding.confidence!=='high'||!deterministicallyCorroborated||!finding.suggestedRepair)return false;
  return ['set-object-layout','wrap-overflow','clear-fixed-dimensions'].includes(finding.suggestedRepair.type)
    && (finding.suggestedRepair.type!=='set-object-layout'||finding.suggestedRepair.width!=='auto');
}

function providerFor(model:ModelDefinition,key:string,baseUrl:string,configJson:string):ModelProvider {
  let config:Record<string,unknown>={};try{config=JSON.parse(configJson)}catch{/* malformed provider configuration is surfaced by normal settings validation */}
  return model.protocol==='openai-responses'
    ? new ResponsesProvider(key,[model],baseUrl)
    : new ChatCompletionsProvider(key,[model],baseUrl,model.protocol==='openrouter',config.provider&&typeof config.provider==='object'?config.provider as Record<string,unknown>:undefined);
}

function validatedImages(images:ImportAuditEvidenceImage[]):ImportAuditEvidenceImage[]{
  if(images.length>4)throw new Error('An import audit call supports at most four evidence images');
  let total=0;const ids=new Set<string>();
  for(const image of images){if(ids.has(image.id))throw new Error(`Duplicate evidence image ID: ${image.id}`);ids.add(image.id);const bytes=Buffer.byteLength(image.data,'base64');if(bytes>20_000_000)throw new Error(`Evidence image is too large: ${image.id}`);total+=bytes;}
  if(total>50_000_000)throw new Error('Evidence images exceed the per-call byte limit');
  return images;
}

export function importAuditReplayKey(input:Pick<ImportAuditRequest,'jobId'|'ordinal'|'action'|'evidenceRefs'|'targetRefs'|'images'>,modelId:string,systemPrompt:string,prompt:string):string{
  const images=validatedImages(input.images??[]),fingerprint=createHash('sha256').update(JSON.stringify({action:input.action,modelId,systemPrompt,prompt,evidenceRefs:input.evidenceRefs,targetRefs:input.targetRefs,images:images.map(image=>({id:image.id,mimeType:image.mimeType,detail:image.detail??'auto',sha256:createHash('sha256').update(Buffer.from(image.data,'base64')).digest('hex')}))})).digest('hex');
  return`academic:${input.jobId}:${input.ordinal}:${input.action}:${fingerprint.slice(0,32)}`;
}

export async function runImportAudit(input:ImportAuditRequest):Promise<ImportAuditResult>{
  if(!Number.isInteger(input.ordinal)||input.ordinal<1||input.ordinal>40)throw new Error('Import audit ordinal must be between 1 and 40');
  const configured=taskModelId(input.action);if(!configured)throw new Error(`No model is configured for ${input.action}`);
  const images=validatedImages(input.images??[]),prompt=renderPrompt(promptKey[input.action],{...input.promptValues,contract:promptTemplate('contract.import-findings')}),systemPrompt=promptTemplate('system.import-review'),baseRequestId=importAuditReplayKey(input,configured,systemPrompt,prompt);
  const retryPrefix=`${baseRequestId}:retry-`,replay=row<{id:string;model_id:string;response_text:string|null;input_tokens:number|null;output_tokens:number|null;status:string;error:string|null}>('SELECT id,model_id,response_text,input_tokens,output_tokens,status,error FROM model_runs WHERE request_id=? OR substr(request_id,1,?)=? ORDER BY CASE status WHEN \'completed\' THEN 0 WHEN \'running\' THEN 1 ELSE 2 END,created_at DESC LIMIT 1',baseRequestId,retryPrefix.length,retryPrefix);
  if(replay?.status==='completed'&&replay.response_text)return{report:validateImportAuditReport(JSON.parse(replay.response_text),input.evidenceRefs,input.targetRefs),runId:replay.id,modelId:replay.model_id,inputTokens:replay.input_tokens??0,outputTokens:replay.output_tokens??0};
  if(replay?.status==='running')throw new Error('Import audit request is already running');
  // A durable failed/cancelled run must not make its import permanently
  // un-retryable. Keep the original run as provenance and give the retry its
  // own request identity; completed runs still replay idempotently above.
  const requestId=replay?`${baseRequestId}:retry-${nanoid(8)}`:baseRequestId;
  const decision=route({action:input.action,input:'',hasVisual:Boolean(input.images?.length),webEnabled:false,estimatedTokens:0,taskModelId:configured},models(),profiles());
  const model=decision.model,setting=providerSetting(model.providerId),apiKey=setting?.enabled?process.env[setting.secret_env_name]:undefined;
  if(!setting||!apiKey)throw new Error(`Provider for ${model.label} is not ready`);
  const runId=nanoid(),attemptId=nanoid(),started=Date.now(),created=now();
  db.prepare(`INSERT INTO model_runs(id,thread_id,request_id,action,provider_id,model_id,profile,routing_reason,context_tier,fallback_model_id,status,created_at)
    VALUES(?,NULL,?,?,?,?,?,?,?,NULL,'running',?)`).run(runId,requestId,input.action,model.providerId,model.id,decision.profile,decision.reason,'import-evidence',created);
  db.prepare(`INSERT INTO model_attempts(id,model_run_id,model_id,provider_id,attempt,status,started_at)VALUES(?,?,?,?,1,'running',?)`).run(attemptId,runId,model.id,model.providerId,created);
  let inputTokens=0,outputTokens=0,responseId:string|undefined;const calls:unknown[]=[];
  try{
    const provider=providerFor(model,apiKey,setting.base_url,setting.config_json),messages=[{role:'system' as const,content:systemPrompt},{role:'user' as const,content:prompt}];let completed=false;
    for await(const event of provider.run({model,messages,tools:[importAuditTool],requiredToolName:importAuditToolName,images,store:false,...(input.signal?{signal:input.signal}:{})})){
      if(event.type==='tool_call'){if(event.name!==importAuditToolName)throw new Error(`Import auditor called an unauthorized tool: ${event.name}`);calls.push(event.input)}
      else if(event.type==='usage'){inputTokens=event.inputTokens;outputTokens=event.outputTokens}
      else if(event.type==='completed'){completed=true;responseId=event.responseId}
      else if(event.type==='error')throw new Error(event.message);
    }
    if(!completed)throw new Error('Import auditor stream ended before completion');
    if(calls.length!==1)throw new Error(calls.length?'Import auditor returned more than one findings report':'Import auditor did not return its required findings report');
    const report=validateImportAuditReport(calls[0],input.evidenceRefs,input.targetRefs),finished=now();
    db.prepare('INSERT INTO tool_events(id,model_run_id,event_type,tool_name,payload_json,created_at)VALUES(?,?,?,?,?,?)').run(nanoid(),runId,'tool_call',importAuditToolName,JSON.stringify(report),finished);
    db.prepare(`UPDATE model_runs SET status='completed',latency_ms=?,input_tokens=?,output_tokens=?,provider_response_id=?,response_text=?,completed_at=? WHERE id=?`).run(Date.now()-started,inputTokens,outputTokens,responseId??null,JSON.stringify(report),finished,runId);
    db.prepare("UPDATE model_attempts SET status='completed',completed_at=? WHERE id=?").run(finished,attemptId);
    return{report,runId,modelId:model.id,inputTokens,outputTokens};
  }catch(error){const finished=now(),message=error instanceof Error?error.message:String(error),cancelled=input.signal?.aborted===true;
    db.prepare('UPDATE model_runs SET status=?,latency_ms=?,error=?,completed_at=? WHERE id=?').run(cancelled?'cancelled':'failed',Date.now()-started,message,finished,runId);
    db.prepare('UPDATE model_attempts SET status=?,error=?,completed_at=? WHERE id=?').run(cancelled?'cancelled':'failed',message,finished,attemptId);
    throw error;
  }
}
