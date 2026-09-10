import{readFile}from'node:fs/promises';import{row}from'../db/index.js';

export interface EffectiveVersion{id:string;document_id:string;sanitized_html_path:string;canonical_text:string;token_estimate:number;revision:number;htmlPath:string}

export function effectiveVersion(versionId:string):EffectiveVersion|undefined{
  const value=row<any>(`SELECT v.id,v.document_id,v.sanitized_html_path,v.canonical_text,v.token_estimate,
    COALESCE(e.revision,0) revision,COALESCE(e.edited_html_path,v.sanitized_html_path) htmlPath
    FROM document_versions v LEFT JOIN document_edit_revisions e ON e.document_version_id=v.id
      AND e.revision=(SELECT MAX(revision) FROM document_edit_revisions WHERE document_version_id=v.id)
    WHERE v.id=? AND v.sanitized_html_path IS NOT NULL`,versionId);
  return value;
}

export async function readEffectiveHtml(versionId:string):Promise<string>{const version=effectiveVersion(versionId);if(!version)throw new Error('Document version not found');return readFile(version.htmlPath,'utf8')}
