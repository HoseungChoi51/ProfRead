import { mkdir,writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll,describe,expect,it } from 'vitest';
import { buildApp } from '../app.js';
import { config } from '../config.js';
import { db,now,row } from '../db/index.js';
import { registerImportJobLifecycle } from './import-jobs.js';

const app=await buildApp(),enqueued:string[]=[];
registerImportJobLifecycle({enqueue:id=>enqueued.push(id)});
afterAll(()=>app.close());

async function auth(){
  const login=await app.inject({method:'POST',url:'/api/auth/login',remoteAddress:'127.0.2.22',payload:{password:'test-owner-password'}});
  return{cookie:login.cookies.map(item=>`${item.name}=${item.value}`).join('; '),'x-csrf-token':login.cookies.find(item=>item.name==='afterdraft_csrf')!.value};
}

describe('magazine article page selection',()=>{
  it('serves only indexed thumbnails and resumes the confirmed inclusive range',async()=>{
    const id=`article-range-${Date.now()}`,created=now(),directory=join(config.dataDir,'imports',id,'inspection','pages'),selection={schemaVersion:1,title:'Target article',pageCount:72,pages:[{page:22,textLength:400,excerpt:'Target article',titleCoverage:1,thumbnailPath:'pages/page-022.jpg'},{page:28,textLength:1800,excerpt:'Closing page',titleCoverage:0,thumbnailPath:'pages/page-028.jpg'}],suggestion:{startPage:22,endPage:28,confidence:'high',source:'local',rationale:'Unique title and body run.',evidencePages:[22,28]}};
    await mkdir(directory,{recursive:true});await writeFile(join(directory,'page-022.jpg'),Buffer.from([0xff,0xd8,0xff,0xd9]));await writeFile(join(directory,'page-028.jpg'),Buffer.from([0xff,0xd8,0xff,0xd9]));
    db.prepare(`INSERT INTO import_jobs(id,source_kind,source_name,source_mime_type,source_path,source_hash,article_title,article_selection_json,status,stage,progress,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id,'pdf','issue.pdf','application/pdf',join(config.dataDir,'imports',id,'source.pdf'),'a'.repeat(64),'Target article',JSON.stringify(selection),'awaiting-selection','article-selection',0.15,created,created);
    const headers=await auth(),unauthorized=await app.inject({method:'GET',url:`/api/import-jobs/${id}/article-pages/22/thumbnail`});expect(unauthorized.statusCode).toBe(401);
    const thumbnail=await app.inject({method:'GET',url:`/api/import-jobs/${id}/article-pages/22/thumbnail`,headers});expect(thumbnail.statusCode).toBe(200);expect(thumbnail.headers['content-type']).toContain('image/jpeg');
    const absent=await app.inject({method:'GET',url:`/api/import-jobs/${id}/article-pages/23/thumbnail`,headers});expect(absent.statusCode).toBe(404);
    const detail=await app.inject({method:'GET',url:`/api/import-jobs/${id}`,headers});expect(detail.json().articleSelection.pages[0]).toEqual(expect.objectContaining({page:22,thumbnailUrl:`/api/import-jobs/${id}/article-pages/22/thumbnail`}));expect(JSON.stringify(detail.json())).not.toContain('thumbnailPath');
    const reversed=await app.inject({method:'POST',url:`/api/import-jobs/${id}/article-selection`,headers,payload:{startPage:28,endPage:22}});expect(reversed.statusCode).toBe(400);
    const confirmed=await app.inject({method:'POST',url:`/api/import-jobs/${id}/article-selection`,headers,payload:{startPage:22,endPage:28}});expect(confirmed.statusCode).toBe(200);expect(confirmed.json()).toEqual(expect.objectContaining({ok:true,status:'queued'}));
    expect(enqueued).toContain(id);expect(row<{status:string;selected_page_start:number;selected_page_end:number}>('SELECT status,selected_page_start,selected_page_end FROM import_jobs WHERE id=?',id)).toEqual({status:'queued',selected_page_start:22,selected_page_end:28});
  });
});
