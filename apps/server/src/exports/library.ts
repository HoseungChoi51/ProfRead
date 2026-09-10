import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {rows} from '../db/index.js';
import {exportData,renderHtml,renderMarkdown} from './render.js';
import {type RepresentationRow} from '../pdf/repository.js';

interface CurrentDocument{id:string;title:string;group_name:string|null;version_id:string;version:number;source_name:string;sanitized_html_path:string|null;created_at:string;edit_revision:number}

export function standaloneHtmlFilename(title:string,documentId:string):string{
  const normalized=[...title.normalize('NFKC')].map(character=>character.charCodeAt(0)<32?' ':character).join('');
  const safe=normalized.replace(/[<>:"/\\|?*]/g,' ').replace(/\s+/g,' ').replace(/^[. ]+|[. ]+$/g,'').slice(0,120).trim()||'Untitled';
  return `${safe} -- ${documentId}.html`;
}

export async function exportHtmlLibrary(outputDirectory:string,exportedAt=new Date().toISOString(),options:{includeOriginalPdfs?:boolean}={}):Promise<{count:number;manifestPath:string}>{
  await mkdir(outputDirectory,{recursive:true,mode:0o750});
  const documents=rows<CurrentDocument>(`SELECT d.id,d.title,g.name group_name,v.id version_id,v.version,v.source_name,v.sanitized_html_path,v.created_at,
    COALESCE((SELECT MAX(revision) FROM document_edit_revisions WHERE document_version_id=v.id),0) edit_revision
    FROM documents d LEFT JOIN article_groups g ON g.id=d.group_id JOIN document_versions v ON v.document_id=d.id
    AND v.version=(SELECT MAX(version) FROM document_versions WHERE document_id=d.id)
    ORDER BY d.title,d.id`);
  const entries=[];
  for(const document of documents){
    const representations=rows<RepresentationRow&{source_version:number;source_name:string;source_imported_at:string}>("SELECT r.*,v.version source_version,v.source_name,v.created_at source_imported_at FROM document_representations r JOIN document_versions v ON v.id=r.document_version_id WHERE v.document_id=? AND (r.kind='pdf' OR v.id=?) ORDER BY v.version,r.kind",document.id,document.version_id);
    const html=representations.find(item=>item.kind==='html'),pdfs=representations.filter(item=>item.kind==='pdf');
    const filename=standaloneHtmlFilename(document.title,document.id),stem=filename.slice(0,-5),files:{filename:string;kind:string;sha256?:string;representationId?:string;sourceVersionId?:string;sourceVersion?:number}[]=[];
    if(document.sanitized_html_path){
      const data=await exportData(document.id,false,html?.id);
      await writeFile(join(outputDirectory,filename),renderHtml(data),{mode:0o640});
      files.push({filename,kind:'html-article'});
    }
    for(const pdf of pdfs){
      const pdfStem=`${stem} -- PDF v${pdf.source_version}`,provenance={representationId:pdf.id,sourceVersionId:pdf.document_version_id,sourceVersion:pdf.source_version};
      if(!pdf.pdf_path||!pdf.pdf_hash)throw new Error(`PDF source is unavailable for article ${document.id}`);
      const copyPdf=async(path:string,expectedHash:string,name:string,kind:string)=>{
        const bytes=await readFile(path),sha256=createHash('sha256').update(bytes).digest('hex');
        if(sha256!==expectedHash)throw new Error(`PDF checksum mismatch for article ${document.id}`);
        await writeFile(join(outputDirectory,name),bytes,{mode:0o640});files.push({filename:name,kind,sha256,...provenance});
      };
      const sourceFilename=`${pdfStem} -- source.pdf`;
      await copyPdf(pdf.pdf_path,pdf.pdf_hash,sourceFilename,'selected-source-pdf');
      if(options.includeOriginalPdfs&&pdf.source_path&&pdf.source_hash&&pdf.source_hash!==pdf.pdf_hash){
        await copyPdf(pdf.source_path,pdf.source_hash,`${pdfStem} -- original.pdf`,'original-source-pdf');
      }
      const data=await exportData(document.id,true,pdf.id),reportFilename=`${pdfStem} -- study-notes.html`;
      const link=`<p><a href="${encodeURIComponent(sourceFilename)}">Open the selected source PDF</a></p>`;
      await writeFile(join(outputDirectory,reportFilename),renderHtml({...data,html:data.html.replace('</body>',`${link}</body>`)}),{mode:0o640});
      await writeFile(join(outputDirectory,`${pdfStem} -- study-notes.md`),renderMarkdown(data),{mode:0o640});
      await writeFile(join(outputDirectory,`${pdfStem} -- study-notes.json`),`${JSON.stringify({title:data.title,sourceName:data.sourceName,...provenance,sourceImportedAt:pdf.source_imported_at,sourceHash:pdf.source_hash,selectedPdfHash:pdf.pdf_hash,sourcePageStart:pdf.source_page_start,sourcePageEnd:pdf.source_page_end,highlights:data.highlights,annotations:data.annotations,artifacts:data.artifacts,messages:data.messages},null,2)}\n`,{mode:0o640});
      files.push({filename:reportFilename,kind:'pdf-study-html',...provenance},{filename:`${pdfStem} -- study-notes.md`,kind:'pdf-study-markdown',...provenance},{filename:`${pdfStem} -- study-notes.json`,kind:'pdf-study-data',...provenance});
    }
    entries.push({documentId:document.id,title:document.title,group:document.group_name,version:document.version,editRevision:document.edit_revision,sourceName:document.source_name,sourceImportedAt:document.created_at,filename:files[0]?.filename??null,files});
  }
  const manifestPath=join(outputDirectory,'manifest.json');
  await writeFile(manifestPath,`${JSON.stringify({exportedAt,count:entries.length,documents:entries},null,2)}\n`,{mode:0o640});
  return{count:entries.length,manifestPath};
}

export const exportLibrary=exportHtmlLibrary;
