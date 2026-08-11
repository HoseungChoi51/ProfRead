const applyingWriters=new Set<string>();
const generatingWriters=new Set<string>();

export function beginWriterGeneration(threadId:string):boolean{
  if(applyingWriters.has(threadId)||generatingWriters.has(threadId))return false;
  generatingWriters.add(threadId);
  return true;
}

export function endWriterGeneration(threadId:string):void{generatingWriters.delete(threadId)}
export function isWriterGenerating(threadId:string):boolean{return generatingWriters.has(threadId)}

export function beginWriterApply(threadId:string):boolean{
  if(applyingWriters.has(threadId)||generatingWriters.has(threadId))return false;
  applyingWriters.add(threadId);
  return true;
}

export function endWriterApply(threadId:string):void{applyingWriters.delete(threadId)}
export function isWriterApplying(threadId:string):boolean{return applyingWriters.has(threadId)}
