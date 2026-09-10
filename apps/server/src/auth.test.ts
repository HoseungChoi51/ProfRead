import { createHash, randomBytes } from 'node:crypto';
import cookie from '@fastify/cookie';
import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { authenticate, registerAuth, requireCsrf } from './auth.js';
import { db, now } from './db/index.js';

const hash = (value:string) => createHash('sha256').update(value).digest('hex');
const sessionIds:string[]=[];
afterEach(()=>{ for(const id of sessionIds.splice(0)) db.prepare('DELETE FROM sessions WHERE id=?').run(id); });

describe('ProfRead session migration',()=>{
  it('promotes valid legacy sessions, preserves expiry, and rejects incorrect CSRF',async()=>{
    const app=Fastify(); await app.register(cookie); registerAuth(app);
    app.post('/write',{preHandler:[authenticate,requireCsrf]},async()=>({ok:true}));
    const id=randomBytes(8).toString('hex'),token=randomBytes(32).toString('base64url'),csrf=randomBytes(24).toString('base64url');
    sessionIds.push(id);
    db.prepare('INSERT INTO sessions(id,token_hash,csrf_hash,expires_at,created_at) VALUES(?,?,?,?,?)').run(id,hash(token),hash(csrf),new Date(Date.now()+3600_000).toISOString(),now());
    const legacy=`afterdraft_session=${token}; afterdraft_csrf=${csrf}`;
    try{
      const promoted=await app.inject({url:'/api/auth/session',headers:{cookie:legacy}});
      expect(promoted.statusCode).toBe(200);
      expect(promoted.cookies.find(item=>item.name==='profread_session')).toMatchObject({value:token,httpOnly:true,sameSite:'Strict'});
      expect(promoted.cookies.find(item=>item.name==='profread_csrf')?.value).toBe(csrf);
      expect(promoted.cookies.find(item=>item.name==='profread_session')?.maxAge).toBeLessThanOrEqual(3600);
      const current=promoted.cookies.map(item=>`${item.name}=${item.value}`).join('; ');
      expect((await app.inject({method:'POST',url:'/write',headers:{cookie:current,'x-csrf-token':'wrong'}})).statusCode).toBe(403);
      expect((await app.inject({method:'POST',url:'/write',headers:{cookie:current,'x-csrf-token':csrf}})).statusCode).toBe(200);
      const loggedOut=await app.inject({method:'POST',url:'/api/auth/logout',headers:{cookie:current,'x-csrf-token':csrf}});
      expect(loggedOut.statusCode).toBe(200);
      expect(loggedOut.cookies.map(item=>item.name).sort()).toEqual(['afterdraft_csrf','afterdraft_session','profread_csrf','profread_session']);
      expect((await app.inject({url:'/api/auth/session',headers:{cookie:legacy}})).statusCode).toBe(401);
    }finally{await app.close()}
  });
});
