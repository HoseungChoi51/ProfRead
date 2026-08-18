export interface ReattachCandidate { blockId:string;text:string;start:number;end:number }
export interface StoredAnchor {
  exact:string;
  prefix:string;
  suffix:string;
  startOffset:number;
  blockId?:string;
  localStartOffset?:number|undefined;
  blockIdentityReliable?:boolean;
  sourceContextOccurrenceCount?:number|undefined;
}
export interface Reattachment { blockId:string;startOffset:number;endOffset:number;score:number;status:'attached'|'unmatched' }

type ExactMatch=Reattachment&{
  sameBlock:boolean;
  atOldLocal:boolean;
  contextExact:boolean;
};

function similarity(a:string,b:string):number{
  if(a===b)return 1;
  if(!a||!b)return 0;
  const left=new Set(a.toLowerCase().split(/\W+/).filter(Boolean)),right=new Set(b.toLowerCase().split(/\W+/).filter(Boolean));
  let common=0;for(const word of left)if(right.has(word))common++;
  return common/Math.max(left.size,right.size,1);
}

function exactMatches(anchor:StoredAnchor,candidates:ReattachCandidate[]):ExactMatch[]{
  const matches:ExactMatch[]=[];
  for(const block of candidates){
    let index=block.text.indexOf(anchor.exact);
    while(index>=0){
      const before=block.text.slice(Math.max(0,index-anchor.prefix.length),index),after=block.text.slice(index+anchor.exact.length,index+anchor.exact.length+anchor.suffix.length);
      const prefixExact=!anchor.prefix||before===anchor.prefix,suffixExact=!anchor.suffix||after===anchor.suffix,sameBlock=block.blockId===anchor.blockId,atOldLocal=Number.isInteger(anchor.localStartOffset)&&index===anchor.localStartOffset;
      const positional=1-Math.min(1,Math.abs((block.start+index)-anchor.startOffset)/Math.max(200,anchor.exact.length*10));
      matches.push({blockId:block.blockId,startOffset:index,endOffset:index+anchor.exact.length,score:.8+.08*Number(prefixExact)+.08*Number(suffixExact)+.02*Number(sameBlock)+.01*Number(atOldLocal)+.01*positional,status:'attached',sameBlock,atOldLocal,contextExact:prefixExact&&suffixExact});
      index=block.text.indexOf(anchor.exact,index+1);
    }
  }
  return matches.sort((left,right)=>right.score-left.score||left.blockId.localeCompare(right.blockId)||left.startOffset-right.startOffset);
}

export function countExactContextOccurrences(anchor:Pick<StoredAnchor,'exact'|'prefix'|'suffix'>,candidates:ReattachCandidate[]):number{
  if(!anchor.exact)return 0;
  let count=0;
  for(const block of candidates){
    let index=block.text.indexOf(anchor.exact);
    while(index>=0){
      const before=block.text.slice(Math.max(0,index-anchor.prefix.length),index),after=block.text.slice(index+anchor.exact.length,index+anchor.exact.length+anchor.suffix.length);
      if((!anchor.prefix||before===anchor.prefix)&&(!anchor.suffix||after===anchor.suffix))count++;
      index=block.text.indexOf(anchor.exact,index+1);
    }
  }
  return count;
}

function asUnmatched(match:Reattachment|undefined):Reattachment{
  return match?{...match,status:'unmatched'}:{blockId:'',startOffset:0,endOffset:0,score:0,status:'unmatched'};
}

/**
 * Reattachment is deliberately conservative: a missing highlight is
 * repairable, while silently choosing another identical quote is not.
 */
export function reattach(anchor:StoredAnchor,candidates:ReattachCandidate[]):Reattachment{
  if(!anchor.exact){
    const sameBlock=anchor.blockId?candidates.find(block=>block.blockId===anchor.blockId):undefined;
    const candidate=sameBlock??candidates.slice().sort((left,right)=>Math.abs(left.start-anchor.startOffset)-Math.abs(right.start-anchor.startOffset))[0];
    return candidate?{blockId:candidate.blockId,startOffset:0,endOffset:0,score:sameBlock?1:0,status:sameBlock?'attached':'unmatched'}:{blockId:'',startOffset:0,endOffset:0,score:0,status:'unmatched'};
  }

  const exact=exactMatches(anchor,candidates),sameBlock=exact.filter(match=>match.sameBlock);
  if(anchor.blockIdentityReliable){
    if(!sameBlock.length){
      const stable=candidates.find(candidate=>candidate.blockId===anchor.blockId);
      return stable?{blockId:stable.blockId,startOffset:0,endOffset:stable.text.length,score:similarity(anchor.exact,stable.text),status:'unmatched'}:asUnmatched(exact[0]);
    }
    const oldLocal=sameBlock.filter(match=>match.atOldLocal&&match.contextExact);
    if(oldLocal.length===1)return oldLocal[0]!;
    const contextual=sameBlock.filter(match=>match.contextExact);
    if(contextual.length===1)return contextual[0]!;
    return asUnmatched(oldLocal[0]??contextual[0]??sameBlock[0]);
  }

  if(anchor.sourceContextOccurrenceCount!==undefined&&anchor.sourceContextOccurrenceCount!==1)return asUnmatched(exact[0]);
  const contextual=exact.filter(match=>match.contextExact);
  if(contextual.length===1)return contextual[0]!;
  if(contextual.length>1)return asUnmatched(contextual[0]);
  if(exact.length)return asUnmatched(exact[0]);

  const fuzzy=candidates.map(block=>{const score=similarity(anchor.exact,block.text);return{blockId:block.blockId,startOffset:0,endOffset:block.text.length,score,status:'unmatched' as const}}).sort((left,right)=>right.score-left.score)[0];
  return fuzzy??{blockId:'',startOffset:0,endOffset:0,score:0,status:'unmatched'};
}
