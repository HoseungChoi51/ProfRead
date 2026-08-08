export interface ReattachCandidate { blockId:string;text:string;start:number;end:number }
export interface StoredAnchor { exact:string;prefix:string;suffix:string;startOffset:number }
export interface Reattachment { blockId:string;startOffset:number;endOffset:number;score:number;status:'attached'|'unmatched' }

function similarity(a:string,b:string):number{if(a===b)return 1;if(!a||!b)return 0;const left=new Set(a.toLowerCase().split(/\W+/).filter(Boolean)),right=new Set(b.toLowerCase().split(/\W+/).filter(Boolean));let common=0;for(const word of left)if(right.has(word))common++;return common/Math.max(left.size,right.size,1);}
export function reattach(anchor:StoredAnchor,candidates:ReattachCandidate[]):Reattachment{
  const exact=candidates.flatMap(block=>{const matches:Reattachment[]=[];let index=block.text.indexOf(anchor.exact);while(index>=0){const positional=1-Math.min(1,Math.abs((block.start+index)-anchor.startOffset)/Math.max(200,anchor.exact.length*10));const before=block.text.slice(Math.max(0,index-anchor.prefix.length),index),after=block.text.slice(index+anchor.exact.length,index+anchor.exact.length+anchor.suffix.length);matches.push({blockId:block.blockId,startOffset:index,endOffset:index+anchor.exact.length,score:.8+.1*similarity(before,anchor.prefix)+.1*similarity(after,anchor.suffix)+.01*positional,status:'attached'});index=block.text.indexOf(anchor.exact,index+1)}return matches;}).sort((a,b)=>b.score-a.score);
  if(exact[0])return exact[0];
  const fuzzy=candidates.map(block=>{const score=similarity(anchor.exact,block.text);return {blockId:block.blockId,startOffset:0,endOffset:block.text.length,score,status:score>=.62?'attached' as const:'unmatched' as const}}).sort((a,b)=>b.score-a.score)[0];
  return fuzzy??{blockId:'',startOffset:0,endOffset:0,score:0,status:'unmatched'};
}
