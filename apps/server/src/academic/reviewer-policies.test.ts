import { nanoid } from 'nanoid';
import { afterEach, describe, expect, it } from 'vitest';
import { db, now } from '../db/index.js';
import {
  createReviewerPolicy,
  deleteReviewerPolicy,
  reviewerGuidanceForJob,
  reviewerPolicySnapshot,
  reviewerPolicySourceContext,
} from './reviewer-policies.js';

const jobs:string[]=[],policies:string[]=[];
afterEach(()=>{
  for(const id of policies.splice(0))deleteReviewerPolicy(id);
  for(const id of jobs.splice(0))db.prepare('DELETE FROM import_jobs WHERE id=?').run(id);
});

function insertUrlJob(input:{sourceName:string;provenance?:unknown;result?:unknown}):string{
  const id=`policy-domain-${nanoid()}`,time=now();
  db.prepare(`INSERT INTO import_jobs(id,source_kind,source_name,source_mime_type,source_path,source_hash,status,stage,provenance_json,result_json,created_at,updated_at)
    VALUES(?,'url',?,'text/uri-list',?,?, 'review-ready','review',?,?,?,?)`)
    .run(id,input.sourceName,`/tmp/${id}.url`,'a'.repeat(64),JSON.stringify(input.provenance??{}),input.result===undefined?null:JSON.stringify(input.result),time,time);
  jobs.push(id);return id;
}

function policy(name:string,domain:string,issueCode?:string):string{
  const created=createReviewerPolicy({name,enabled:true,priority:10,match:{sourceKind:'url',domain,...(issueCode?{issueCode}:{})},action:'context-note'});
  policies.push(created.id);return created.id;
}
function selected(ids:string[],values:Array<{id:string}>):string[]{return values.map(value=>value.id).filter(id=>ids.includes(id)).sort()}

describe('reviewer policy publication domains',()=>{
  it('round-trips a UI canonical-domain rule for a DOI source without enabling a generic DOI rule',()=>{
    const jobId=insertUrlJob({
      sourceName:'10.1515/nanoph-2023-0852',
      provenance:{source:{
        requestedUrl:'https://doi.org/10.1515/nanoph-2023-0852',
        finalUrl:'https://onlinelibrary.wiley.com/doi/10.1515/nanoph-2023-0852',
        canonicalUrl:'https://www.degruyter.com/document/doi/10.1515/nanoph-2023-0852/html',
        redirectChain:['https://doi.org/10.1515/nanoph-2023-0852','https://resolver.example/forward'],
      }},
    });
    const canonical=policy('Canonical publisher','www.degruyter.com','figure-cropped'),resolved=policy('Resolved publisher','onlinelibrary.wiley.com','figure-cropped'),doi=policy('Generic DOI','doi.org','figure-cropped'),redirect=policy('Intermediate redirect','resolver.example','figure-cropped'),ids=[canonical,resolved,doi,redirect];

    expect(reviewerPolicySourceContext({jobId})).toEqual({
      sourceKind:'url',sourceName:'10.1515/nanoph-2023-0852',domain:'www.degruyter.com',domains:['www.degruyter.com','onlinelibrary.wiley.com'],
    });
    const snapshot=reviewerPolicySnapshot({jobId}),prompt=JSON.parse(snapshot.promptJson);
    expect(selected(ids,snapshot.policies)).toEqual([canonical,resolved].sort());
    expect(prompt.context).toMatchObject({domain:'www.degruyter.com',domains:['www.degruyter.com','onlinelibrary.wiley.com']});
    expect(selected(ids,reviewerGuidanceForJob(jobId,{issueCode:'figure-cropped',evidenceKinds:['object'],sources:['model'],sourceActions:['import-visual-audit']}))).toEqual([canonical,resolved].sort());
    expect(selected(ids,reviewerGuidanceForJob(jobId,{issueCode:'table-overflow',evidenceKinds:['object'],sources:['model'],sourceActions:['import-visual-audit']}))).toEqual([]);
  });

  it('uses the redirect destination when a submitted publisher URL resolves elsewhere',()=>{
    const jobId=insertUrlJob({sourceName:'https://short.publisher.example/paper',provenance:{source:{
      submittedUrl:'https://short.publisher.example/paper',
      resolvedUrl:'https://journal.publisher.example/article/42',
      redirectChain:['https://short.publisher.example/paper','https://gateway.publisher.example/route'],
    }}}),resolved=policy('Resolved redirect destination','journal.publisher.example'),submitted=policy('Submitted redirect origin','short.publisher.example'),intermediate=policy('Redirect intermediate','gateway.publisher.example'),ids=[resolved,submitted,intermediate];

    expect(reviewerPolicySourceContext({jobId})).toMatchObject({domain:'journal.publisher.example',domains:['journal.publisher.example']});
    expect(selected(ids,reviewerPolicySnapshot({jobId}).policies)).toEqual([resolved]);
  });

  it('falls back to a bare DOI resolver only without resolved provenance and reads staged provenance when needed',()=>{
    expect(reviewerPolicySourceContext({sourceKind:'url',sourceName:'10.1234/example.7'})).toMatchObject({domain:'doi.org',domains:['doi.org']});

    const jobId=insertUrlJob({sourceName:'10.1234/example.7',result:{manifest:{source:{
      canonical_url:'https://archive.publisher.example/articles/7',
      final_url:'https://resolved.publisher.example/full/7',
      requested_url:'https://doi.org/10.1234/example.7',
    }}}});
    expect(reviewerPolicySourceContext({jobId})).toMatchObject({domain:'archive.publisher.example',domains:['archive.publisher.example','resolved.publisher.example']});
  });
});
