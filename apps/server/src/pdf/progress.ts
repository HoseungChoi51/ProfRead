import { z } from 'zod';
import { db, now, row } from '../db/index.js';
import { representation } from './repository.js';

export function saveRepresentationProgress(documentId:string,body:unknown):{ok:true}|undefined{
  if(!body||typeof body!=='object'||!('representationId' in body))return;
  const parsed=z.object({representationId:z.string().min(1),page:z.number().int().positive().optional(),offsetRatio:z.number().min(0).max(1).optional(),zoom:z.number().min(0.1).max(8).optional(),rotation:z.number().int().multipleOf(90).optional(),lastThreadId:z.string().nullable().optional()}).safeParse(body);
  if(!parsed.success)throw Object.assign(new Error('Invalid reading position'),{statusCode:400});
  const value=parsed.data,source=representation(value.representationId);
  if(!source||!row('SELECT id FROM document_versions WHERE id=? AND document_id=?',source.document_version_id,documentId))throw Object.assign(new Error('Reading view does not belong to this article'),{statusCode:400});
  if(value.lastThreadId&&!row('SELECT id FROM threads WHERE id=? AND document_id=?',value.lastThreadId,documentId))throw Object.assign(new Error('Discussion does not belong to this article'),{statusCode:400});
  const preferenceOnly=Object.keys(body).length===1;
  if(!preferenceOnly&&value.offsetRatio===undefined)throw Object.assign(new Error('Reading position requires an offset'),{statusCode:400});
  if(!preferenceOnly&&source.kind==='pdf'&&(!value.page||value.page>(source.page_count??0)))throw Object.assign(new Error('Invalid PDF reading page'),{statusCode:400});
  db.prepare('INSERT INTO document_view_preferences(document_id,representation_id)VALUES(?,?) ON CONFLICT(document_id) DO UPDATE SET representation_id=excluded.representation_id').run(documentId,source.id);
  if(preferenceOnly)return{ok:true};
  if(source.kind==='html')return;
  db.prepare(`INSERT INTO representation_progress(representation_id,page,offset_ratio,zoom,rotation,last_thread_id,updated_at)VALUES(?,?,?,?,?,?,?)
    ON CONFLICT(representation_id) DO UPDATE SET page=excluded.page,offset_ratio=excluded.offset_ratio,zoom=excluded.zoom,rotation=excluded.rotation,last_thread_id=COALESCE(excluded.last_thread_id,representation_progress.last_thread_id),updated_at=excluded.updated_at`).run(source.id,value.page!,value.offsetRatio!,value.zoom??1,((value.rotation??0)%360+360)%360,value.lastThreadId??null,now());
  return{ok:true};
}
