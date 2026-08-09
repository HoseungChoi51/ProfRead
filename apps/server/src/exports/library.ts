import {mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {rows} from '../db/index.js';
import {exportData,renderHtml} from './render.js';

interface CurrentDocument{id:string;title:string;version:number;source_name:string;created_at:string}

export function standaloneHtmlFilename(title:string,documentId:string):string{
  const normalized=[...title.normalize('NFKC')].map(character=>character.charCodeAt(0)<32?' ':character).join('');
  const safe=normalized.replace(/[<>:"/\\|?*]/g,' ').replace(/\s+/g,' ').replace(/^[. ]+|[. ]+$/g,'').slice(0,120).trim()||'Untitled';
  return `${safe} -- ${documentId}.html`;
}

export async function exportHtmlLibrary(outputDirectory:string,exportedAt=new Date().toISOString()):Promise<{count:number;manifestPath:string}>{
  await mkdir(outputDirectory,{recursive:true,mode:0o750});
  const documents=rows<CurrentDocument>(`SELECT d.id,d.title,v.version,v.source_name,v.created_at
    FROM documents d JOIN document_versions v ON v.document_id=d.id
    AND v.version=(SELECT MAX(version) FROM document_versions WHERE document_id=d.id)
    ORDER BY d.title,d.id`);
  const entries=[];
  for(const document of documents){
    const filename=standaloneHtmlFilename(document.title,document.id);
    const data=await exportData(document.id,false);
    await writeFile(join(outputDirectory,filename),renderHtml(data),{mode:0o640});
    entries.push({documentId:document.id,title:document.title,version:document.version,sourceName:document.source_name,sourceImportedAt:document.created_at,filename});
  }
  const manifestPath=join(outputDirectory,'manifest.json');
  await writeFile(manifestPath,`${JSON.stringify({exportedAt,count:entries.length,documents:entries},null,2)}\n`,{mode:0o640});
  return{count:entries.length,manifestPath};
}
