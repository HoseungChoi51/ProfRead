import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import staticFiles from '@fastify/static';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.js';
import { authenticate, registerAuth, requireCsrf } from './auth.js';
import { registerDocumentRoutes } from './routes/documents.js';
import { registerThreadRoutes } from './routes/threads.js';
import { registerRunRoutes } from './routes/runs.js';
import { registerSettingsRoutes, seedModelSettings } from './models/settings.js';
import { registerKnowledgeRoutes } from './routes/knowledge.js';
import { registerExportRoutes } from './routes/exports.js';
import { registerEditRoutes } from './routes/edits.js';

export async function buildApp() {
  const app=Fastify({logger:true,bodyLimit:config.limits.zipBytes+1024});
  await app.register(cookie,{secret:config.sessionSecret});
  await app.register(cors,{origin:false,credentials:true});
  await app.register(rateLimit,{global:false});
  await app.register(multipart,{limits:{files:1,fileSize:config.limits.zipBytes}});
  app.addHook('onSend',async(_request,reply,payload)=>{reply.header('x-content-type-options','nosniff').header('permissions-policy','camera=(), microphone=(), geolocation=()').header('x-frame-options','SAMEORIGIN');if(!reply.hasHeader('referrer-policy'))reply.header('referrer-policy','no-referrer');if(!reply.hasHeader('content-security-policy'))reply.header('content-security-policy',"default-src 'self'; frame-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'");return payload;});
  registerAuth(app);
  app.addHook('preHandler',async(request,reply)=>{if(!request.url.startsWith('/api/')||request.url==='/api/auth/login')return;await authenticate(request,reply);if(!reply.sent)await requireCsrf(request,reply);});
  seedModelSettings();registerDocumentRoutes(app);registerThreadRoutes(app);registerRunRoutes(app);registerSettingsRoutes(app);registerKnowledgeRoutes(app);registerExportRoutes(app);registerEditRoutes(app);
  app.get('/health',async()=>({status:'ok'}));
  if(existsSync(join(config.webDir,'index.html'))){await app.register(staticFiles,{root:config.webDir,prefix:'/',wildcard:false});app.setNotFoundHandler(async(request,reply)=>request.url.startsWith('/api/')?reply.code(404).send({error:'Not found'}):reply.type('text/html').sendFile('index.html'));}
  app.setErrorHandler((error:Error & {statusCode?:number},request,reply)=>{request.log.error(error);if(!reply.sent)reply.code(error.statusCode??500).send({error:error.statusCode&&error.statusCode<500?error.message:'Internal server error'});});
  return app;
}
