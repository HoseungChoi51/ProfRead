import { promisify } from 'node:util';
import yauzl from 'yauzl';
import { config } from '../config.js';

const openZip=promisify<string,yauzl.Options,yauzl.ZipFile>(yauzl.open);
export type UploadedArchiveKind='html'|'tex-zip';

function safeName(raw:string):string{
  const name=raw.replaceAll('\\','/');
  if(!name||name.includes('\0')||name.startsWith('/')||/^[A-Za-z]:/.test(name)||name.split('/').includes('..'))throw new Error(`Unsafe ZIP path: ${JSON.stringify(raw)}`);
  return name;
}

/** Inventory an uploaded project before deciding which converter owns it. */
export async function inspectUploadedArchive(path:string):Promise<{kind:UploadedArchiveKind;htmlEntries:string[];texEntries:string[]}>{
  const zip=await openZip(path,{lazyEntries:true,decodeStrings:true,validateEntrySizes:true,autoClose:true}),seen=new Set<string>(),htmlEntries:string[]=[],texEntries:string[]=[];
  let count=0,total=0;
  await new Promise<void>((resolve,reject)=>{
    let settled=false;
    const fail=(error:unknown)=>{if(!settled){settled=true;zip.close();reject(error)}};
    zip.on('error',fail);zip.on('end',()=>{if(!settled){settled=true;resolve()}});
    zip.on('entry',entry=>{try{
      const name=safeName(entry.fileName),mode=(entry.externalFileAttributes>>>16)&0xffff;
      if(seen.has(name))throw new Error(`Duplicate ZIP entry: ${name}`);seen.add(name);
      if((mode&0o170000)===0o120000||(entry.generalPurposeBitFlag&1)!==0)throw new Error(`Unsafe ZIP entry: ${name}`);
      if(++count>config.limits.entries||entry.uncompressedSize>config.limits.expandedBytes)throw new Error('ZIP entry limit exceeded');
      if(entry.compressedSize>0&&entry.uncompressedSize/entry.compressedSize>200)throw new Error('ZIP expansion ratio exceeded');
      total+=entry.uncompressedSize;if(total>config.limits.expandedBytes)throw new Error('ZIP expansion limit exceeded');
      if(!name.endsWith('/')){if(/\.html?$/i.test(name))htmlEntries.push(name);if(/\.tex$/i.test(name))texEntries.push(name)}
      zip.readEntry();
    }catch(error){fail(error)}});
    zip.readEntry();
  });
  htmlEntries.sort();texEntries.sort();
  if(htmlEntries.length)return{kind:'html',htmlEntries,texEntries};
  if(texEntries.length)return{kind:'tex-zip',htmlEntries,texEntries};
  throw new Error('ZIP does not contain an HTML article or TeX source');
}
