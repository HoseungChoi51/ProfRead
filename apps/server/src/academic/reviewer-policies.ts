import { nanoid } from 'nanoid';
import { z } from 'zod';
import { academicReviewerPolicyActionSchema, type AcademicReviewerPolicyAction } from '@afterdraft/shared';
import { db, now, row, rows } from '../db/index.js';
import { normalizePublishedLocator } from './published-utils.js';

export const reviewerPolicyMatchSchema=z.object({
  issueCode:z.string().trim().min(1).max(64).optional(),
  evidenceKind:z.string().trim().min(1).max(64).optional(),
  source:z.enum(['deterministic','model']).optional(),
  sourceAction:z.string().trim().min(1).max(64).optional(),
  sourceKind:z.string().trim().min(1).max(32).optional(),
  domain:z.string().trim().toLowerCase().min(1).max(253).regex(/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))*$/).optional(),
}).strict();
const createSchema=z.object({
  name:z.string().trim().min(1).max(160),
  enabled:z.boolean().default(true),
  priority:z.number().int().min(0).max(10_000).default(100),
  match:reviewerPolicyMatchSchema,
  action:academicReviewerPolicyActionSchema,
}).strict();
const updateSchema=createSchema.partial().refine(value=>Object.keys(value).length>0,'At least one policy field is required');

export type ReviewerPolicyMatch=z.infer<typeof reviewerPolicyMatchSchema>;
export type ReviewerPolicy={
  id:string;name:string;enabled:boolean;priority:number;match:ReviewerPolicyMatch;
  action:AcademicReviewerPolicyAction;createdAt:string;updatedAt:string;
};
type StoredPolicy={id:string;name:string;enabled:number;priority:number;match_json:string;action:AcademicReviewerPolicyAction;created_at:string;updated_at:string};
function fail(message:string,statusCode:number):never{throw Object.assign(new Error(message),{statusCode})}
function parseJson<T>(value:string|null|undefined,fallback:T):T{if(!value)return fallback;try{return JSON.parse(value) as T}catch{return fallback}}
function publicPolicy(item:StoredPolicy):ReviewerPolicy{return{id:item.id,name:item.name,enabled:Boolean(item.enabled),priority:item.priority,match:parseJson(item.match_json,{}),action:item.action,createdAt:item.created_at,updatedAt:item.updated_at}}

export function listReviewerPolicies():ReviewerPolicy[]{
  return rows<StoredPolicy>('SELECT * FROM academic_reviewer_policies ORDER BY priority,id').map(publicPolicy);
}
export function createReviewerPolicy(input:unknown):ReviewerPolicy{
  const value=createSchema.parse(input),time=now(),id=nanoid();
  db.prepare('INSERT INTO academic_reviewer_policies(id,name,enabled,priority,match_json,action,created_at,updated_at)VALUES(?,?,?,?,?,?,?,?)')
    .run(id,value.name,Number(value.enabled),value.priority,JSON.stringify(value.match),value.action,time,time);
  return publicPolicy(row<StoredPolicy>('SELECT * FROM academic_reviewer_policies WHERE id=?',id)!);
}
export function updateReviewerPolicy(id:string,input:unknown):ReviewerPolicy{
  const value=updateSchema.parse(input),stored=row<StoredPolicy>('SELECT * FROM academic_reviewer_policies WHERE id=?',id);if(!stored)fail('Reviewer policy not found',404);
  const next={name:value.name??stored.name,enabled:value.enabled??Boolean(stored.enabled),priority:value.priority??stored.priority,match:value.match??parseJson<ReviewerPolicyMatch>(stored.match_json,{}),action:value.action??stored.action},time=now();
  db.prepare('UPDATE academic_reviewer_policies SET name=?,enabled=?,priority=?,match_json=?,action=?,updated_at=? WHERE id=?')
    .run(next.name,Number(next.enabled),next.priority,JSON.stringify(next.match),next.action,time,id);
  return publicPolicy(row<StoredPolicy>('SELECT * FROM academic_reviewer_policies WHERE id=?',id)!);
}
export function deleteReviewerPolicy(id:string):{ok:true}{const result=db.prepare('DELETE FROM academic_reviewer_policies WHERE id=?').run(id);if(!result.changes)fail('Reviewer policy not found',404);return{ok:true}}

export type ReviewerGuidanceSubject={issueCode:string;evidenceKinds:string[];sources:string[];sourceActions:string[];sourceKind?:string;domain?:string;domains?:string[]};
export type ReviewerPolicySourceContext={sourceKind:string|null;sourceName:string|null;domain:string|null;domains:string[]};
type StoredSourceContext={source_kind:string;source_name:string;provenance_json:string;result_json:string|null};
type JsonRecord=Record<string,unknown>;
const domainPattern=/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))*$/;
function recordValue(value:unknown):JsonRecord|null{return value&&typeof value==='object'&&!Array.isArray(value)?value as JsonRecord:null}
function nestedRecord(value:unknown,...keys:string[]):JsonRecord|null{let current:unknown=value;for(const key of keys){const record=recordValue(current);if(!record)return null;current=record[key]}return recordValue(current)}
function stringField(value:JsonRecord|null,...keys:string[]):string|null{for(const key of keys){const item=value?.[key];if(typeof item==='string'&&item.trim())return item.trim()}return null}
function stringArrayField(value:JsonRecord|null,...keys:string[]):string[]{for(const key of keys){const item=value?.[key];if(Array.isArray(item))return item.filter((entry):entry is string=>typeof entry==='string'&&Boolean(entry.trim())).slice(0,32)}return[]}
function locatorDomain(value:string|null):string|null{
  if(!value||value.length>4096)return null;
  try{const domain=normalizePublishedLocator(value).url.hostname.toLowerCase().replace(/\.$/,'');return domainPattern.test(domain)?domain:null}catch{return null}
}
function uniqueDomains(values:Array<string|null>):string[]{return[...new Set(values.filter((value):value is string=>Boolean(value)))]}
function sourceRecord(value:unknown):JsonRecord|null{const root=recordValue(value);return recordValue(root?.source)??root}
function parsedSourceRecords(job:StoredSourceContext|undefined):JsonRecord[]{
  if(!job)return[];
  const provenance=parseJson<unknown>(job.provenance_json,null),result=parseJson<unknown>(job.result_json,null),records=[sourceRecord(provenance),nestedRecord(result,'manifest','source')];
  return records.filter((value):value is JsonRecord=>Boolean(value));
}
function domainsFor(records:JsonRecord[],sourceName:string|null):{domain:string|null;domains:string[]}{
  const canonical=uniqueDomains(records.map(value=>locatorDomain(stringField(value,'canonicalUrl','canonical_url'))));
  const resolved=uniqueDomains(records.flatMap(value=>[
    locatorDomain(stringField(value,'resolvedUrl','resolved_url')),
    locatorDomain(stringField(value,'finalUrl','final_url')),
  ]));
  if(canonical.length||resolved.length){const domains=uniqueDomains([...canonical,...resolved]);return{domain:canonical[0]??resolved[0]??null,domains}}
  const submitted=uniqueDomains(records.flatMap(value=>[
    locatorDomain(stringField(value,'submittedUrl','submitted_url')),
    locatorDomain(stringField(value,'requestedUrl','requested_url')),
  ]));
  if(submitted.length)return{domain:submitted[0]??null,domains:submitted};
  const redirects=uniqueDomains(records.flatMap(value=>stringArrayField(value,'redirectChain','redirect_chain').map(item=>locatorDomain(item))));
  if(redirects.length)return{domain:redirects.at(-1)??null,domains:redirects};
  const sourceDomain=locatorDomain(sourceName);return{domain:sourceDomain,domains:sourceDomain?[sourceDomain]:[]};
}
export function reviewerPolicySourceContext(input:{jobId?:string;sourceKind?:string;sourceName?:string}={}):ReviewerPolicySourceContext{
  const job=input.jobId?row<StoredSourceContext>('SELECT source_kind,source_name,provenance_json,result_json FROM import_jobs WHERE id=?',input.jobId):undefined,sourceName=input.sourceName??job?.source_name??null,sourceKind=input.sourceKind??job?.source_kind??null;
  if(sourceKind!=='url')return{sourceKind,sourceName,domain:null,domains:[]};
  return{sourceKind,sourceName,...domainsFor(parsedSourceRecords(job),sourceName)};
}
function subjectDomains(subject:ReviewerGuidanceSubject):string[]{return uniqueDomains([...(subject.domains??[]).map(value=>{const domain=value.trim().toLowerCase().replace(/\.$/,'');return domainPattern.test(domain)?domain:null}),subject.domain?subject.domain.trim().toLowerCase().replace(/\.$/,''):null])}
function matches(policy:ReviewerPolicy,subject:ReviewerGuidanceSubject):boolean{
  const match=policy.match,domains=subjectDomains(subject);
  return (!match.issueCode||match.issueCode===subject.issueCode)
    &&(!match.evidenceKind||subject.evidenceKinds.includes(match.evidenceKind))
    &&(!match.source||subject.sources.includes(match.source))
    &&(!match.sourceAction||subject.sourceActions.includes(match.sourceAction))
    &&(!match.sourceKind||match.sourceKind===subject.sourceKind)
    &&(!match.domain||domains.includes(match.domain));
}
export function reviewerGuidanceFor(subject:ReviewerGuidanceSubject):ReviewerPolicy[]{return listReviewerPolicies().filter(policy=>policy.enabled&&matches(policy,subject))}
export function reviewerGuidanceForJob(jobId:string,subject:ReviewerGuidanceSubject):ReviewerPolicy[]{const context=reviewerPolicySourceContext({jobId});return reviewerGuidanceFor({issueCode:subject.issueCode,evidenceKinds:subject.evidenceKinds,sources:subject.sources,sourceActions:subject.sourceActions,domains:context.domains,...(context.sourceKind?{sourceKind:context.sourceKind}:{}),...(context.domain?{domain:context.domain}:{})})}
export const reviewerPolicyEffects:Record<AcademicReviewerPolicyAction,string>={
  'require-stronger-evidence':'Abstain unless independent, relevant DOM, visual, or immutable-source evidence supports the issue.',
  'lower-priority':'Reduce unsupported or low-impact escalation, but never suppress a defect supported by relevant evidence.',
  'increase-scrutiny':'Require more relevant evidence coverage and support before confirming or proposing a repair.',
  'context-note':'Use this policy only as calibration context; it cannot decide an issue or bypass validation.',
};
export function reviewerPolicySnapshot(input:{jobId?:string;sourceKind?:string;sourceName?:string}={}):{policies:ReviewerPolicy[];promptJson:string}{
  const context=reviewerPolicySourceContext(input);
  const policies=listReviewerPolicies().filter(policy=>policy.enabled&&(!policy.match.sourceKind||policy.match.sourceKind===context.sourceKind)&&(!policy.match.domain||context.domains.includes(policy.match.domain)));
  return{policies,promptJson:JSON.stringify({version:1,context,policies:policies.map(({id,name,priority,match,action})=>({id,name,priority,match,action,effect:reviewerPolicyEffects[action]})),effects:reviewerPolicyEffects,constraint:'Reviewer policies are guidance only. They never decide an issue, suppress directly supported defects, or bypass repair validation.'})};
}
