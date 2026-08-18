export interface AnchorContextWindow { prefix:string;suffix:string }

/** Browser Range offsets are UTF-16 code units, but a valid boundary may not
 * fall between the high and low surrogate of one Unicode code point. */
export function isUtf16Boundary(text:string,offset:number):boolean{
  if(!Number.isInteger(offset)||offset<0||offset>text.length)return false;
  if(offset===0||offset===text.length)return true;
  const before=text.charCodeAt(offset-1),after=text.charCodeAt(offset);
  return !(before>=0xd800&&before<=0xdbff&&after>=0xdc00&&after<=0xdfff);
}

/**
 * Returns nearby context in browser-compatible UTF-16 coordinates. A context
 * edge widens by one code unit when the nominal limit would bisect a surrogate
 * pair; the selected start/end offsets themselves are never changed.
 */
export function utf16ContextWindow(text:string,start:number,end:number,maxUnits=32):AnchorContextWindow{
  if(!Number.isInteger(maxUnits)||maxUnits<0||start>end||!isUtf16Boundary(text,start)||!isUtf16Boundary(text,end))throw new RangeError('Anchor offsets must be valid UTF-16 boundaries');
  let prefixStart=Math.max(0,start-maxUnits),suffixEnd=Math.min(text.length,end+maxUnits);
  if(!isUtf16Boundary(text,prefixStart))prefixStart--;
  if(!isUtf16Boundary(text,suffixEnd))suffixEnd++;
  return{prefix:text.slice(prefixStart,start),suffix:text.slice(end,suffixEnd)};
}
