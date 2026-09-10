import { nanoid } from 'nanoid';
import { z } from 'zod';
import { academicReviewIssueDecisionSchema, type AcademicReviewIssueDecision } from '@profread/shared';
import { db, now, row, rows } from '../db/index.js';

export const reviewerFeedbackInputSchema=z.object({
  decision:academicReviewIssueDecisionSchema.optional(),
  verdict:academicReviewIssueDecisionSchema.optional(),
  reason:z.string().trim().max(2000).optional(),
  comment:z.string().trim().max(5000).optional(),
  reviewerNote:z.string().trim().max(5000).optional(),
  note:z.string().trim().max(5000).optional(),
}).strict().superRefine((value,context)=>{
  if(value.decision&&value.verdict&&value.decision!==value.verdict)context.addIssue({code:'custom',message:'decision and verdict must agree'});
  if(!value.decision&&!value.verdict&&value.reason===undefined&&value.comment===undefined&&value.reviewerNote===undefined&&value.note===undefined)context.addIssue({code:'custom',message:'At least one feedback field is required'});
});
export type ReviewerFeedback={
  id:string;decision:AcademicReviewIssueDecision|null;reason:string|null;comment:string|null;reviewerNote:string|null;createdAt:string;
};
type StoredFeedback={id:string;decision:AcademicReviewIssueDecision|null;reason:string|null;comment:string|null;reviewer_note:string|null;created_at:string};
function fail(message:string,statusCode:number):never{throw Object.assign(new Error(message),{statusCode})}
function publicFeedback(item:StoredFeedback):ReviewerFeedback{return{id:item.id,decision:item.decision,reason:item.reason,comment:item.comment,reviewerNote:item.reviewer_note,createdAt:item.created_at}}

export function reviewerFeedbackForIssue(issueId:string):ReviewerFeedback|null{
  const item=row<StoredFeedback>('SELECT id,decision,reason,comment,reviewer_note,created_at FROM import_reviewer_feedback WHERE review_issue_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1',issueId);
  return item?publicFeedback(item):null;
}
export function latestReviewerFeedback(jobId:string):Map<string,ReviewerFeedback>{
  const result=new Map<string,ReviewerFeedback>(),items=rows<StoredFeedback&{review_issue_id:string}>('SELECT id,review_issue_id,decision,reason,comment,reviewer_note,created_at FROM import_reviewer_feedback WHERE import_job_id=? ORDER BY created_at DESC,rowid DESC',jobId);
  for(const item of items)if(!result.has(item.review_issue_id))result.set(item.review_issue_id,publicFeedback(item));
  return result;
}
export function saveReviewerFeedback(jobId:string,issueId:string,input:unknown):ReviewerFeedback{
  const value=reviewerFeedbackInputSchema.parse(input),job=row<{status:string;stage:string}>('SELECT status,stage FROM import_jobs WHERE id=?',jobId);if(!job)fail('Import job not found',404);if(job.status!=='review-ready'||!['review','publish-failed'].includes(job.stage))fail('Review feedback can only be changed during stable review',409);
  const issue=row<{id:string}>('SELECT id FROM import_review_issues WHERE id=? AND import_job_id=?',issueId,jobId);if(!issue)fail('Review issue not found',404);
  const submittedDecision=value.decision??value.verdict,submittedNote=value.reviewerNote??value.note,id=nanoid(),time=now();
  db.exec('BEGIN IMMEDIATE');try{
    const previous=reviewerFeedbackForIssue(issueId),decision=submittedDecision===undefined?(previous?.decision??null):submittedDecision,reason=value.reason===undefined?(previous?.reason??null):(value.reason||null),comment=value.comment===undefined?(previous?.comment??null):(value.comment||null),reviewerNote=submittedNote===undefined?(previous?.reviewerNote??null):(submittedNote||null);
    db.prepare('INSERT INTO import_reviewer_feedback(id,import_job_id,review_issue_id,decision,reason,comment,reviewer_note,created_at)VALUES(?,?,?,?,?,?,?,?)')
      .run(id,jobId,issueId,decision,reason,comment,reviewerNote,time);
    if(submittedDecision){const verification=submittedDecision==='accepted'?'confirmed':submittedDecision==='dismissed'?'rejected':'resolved';db.prepare('UPDATE import_review_issues SET status=?,verification_status=?,verification_reason=?,updated_at=? WHERE id=? AND import_job_id=?').run(submittedDecision,verification,'Reviewer verdict: '+submittedDecision,time,issueId,jobId)}
    db.exec('COMMIT');
  }catch(error){db.exec('ROLLBACK');throw error}
  return publicFeedback(row<StoredFeedback>('SELECT id,decision,reason,comment,reviewer_note,created_at FROM import_reviewer_feedback WHERE id=?',id)!);
}
