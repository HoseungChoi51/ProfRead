import {
  capabilitySchema,
  modelDefinitionSchema,
  modelProfileSchema,
  taskActionSchema,
  taskModelRouteSchema,
  type ModelDefinition,
  type ModelProfile,
  type TaskAction,
  type TaskModelRoute,
} from '@afterdraft/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db, row, rows } from '../db/index.js';
import { promptTemplateSettings, resetPromptTemplate, savePromptTemplate } from './prompts.js';
import { behaviorSettingsResponse, resetContextBehaviorSettings, saveContextBehaviorSettings } from './behavior.js';
import { academicImportSettingsResponse, resetAcademicImportSettings, saveAcademicImportSettings } from './academic-settings.js';

const gpt56Capabilities={text:true,vision:true,structuredOutput:true,functionTools:true,providerWebSearch:true,reasoningControl:true,imageGeneration:true,streaming:true};
const defaultProfiles:Record<ModelProfile['name'],string[]>= {
  quick:['gpt-5.6-luna'], standard:['gpt-5.6-terra'], deep:['gpt-5.6-sol'],
  vision:['gpt-5.6-sol'], research:['gpt-5.6-sol'], digest:['gpt-5.6-terra'],
};
const defaultTaskModels:Record<TaskAction,string>={
  define:'gpt-5.6-luna', explain:'gpt-5.6-terra', eli14:'gpt-5.6-luna', ask:'gpt-5.6-terra',
  'polish-note':'gpt-5.6-luna',
  visualize:'gpt-5.6-sol', research:'gpt-5.6-sol', summarize:'gpt-5.6-terra', tldr:'gpt-5.6-luna',
  'half-page':'gpt-5.6-terra', 'visual-recap':'gpt-5.6-sol', compact:'gpt-5.6-luna',
  'document-write':'gpt-5.6-sol', 'review-summary':'gpt-5.6-terra',
  'import-triage':'gpt-5.6-luna', 'import-semantic-audit':'gpt-5.6-terra',
  'import-visual-audit':'gpt-5.6-sol', 'import-adjudicate':'gpt-5.6-sol',
  'import-verify-repair':'gpt-5.6-terra', 'import-repair-plan':'gpt-5.6-sol',
};

export function seedModelSettings():void {
  const provider=db.prepare('INSERT OR IGNORE INTO model_settings (id,provider_id,label,protocol,base_url,secret_env_name,config_json) VALUES (?,?,?,?,?,?,?)');
  provider.run('openai','openai','OpenAI','openai-responses','https://api.openai.com/v1','OPENAI_API_KEY','{}');
  provider.run('openrouter','openrouter','OpenRouter','openrouter','https://openrouter.ai/api/v1','OPENROUTER_API_KEY','{}');
  const insert=db.prepare('INSERT OR IGNORE INTO model_definitions (id,provider_id,label,protocol,context_window,max_output,capabilities_json,priority) VALUES (?,?,?,?,?,?,?,?)');
  insert.run('gpt-5.6-luna','openai','GPT-5.6 Luna','openai-responses',1_047_576,32_768,JSON.stringify(gpt56Capabilities),10);
  insert.run('gpt-5.6-terra','openai','GPT-5.6 Terra','openai-responses',1_047_576,32_768,JSON.stringify(gpt56Capabilities),20);
  insert.run('gpt-5.6-sol','openai','GPT-5.6 Sol','openai-responses',1_047_576,32_768,JSON.stringify(gpt56Capabilities),30);
  insert.run('gpt-6-astra','openai','GPT-6 Astra','openai-responses',1_050_000,128_000,JSON.stringify(gpt56Capabilities),40);
  db.prepare("UPDATE model_definitions SET enabled=0 WHERE id IN ('gpt-4.1-mini','gpt-4.1')").run();
  for(const [name,modelIds] of Object.entries(defaultProfiles) as Array<[ModelProfile['name'],string[]]>){
    const current=row<{model_ids_json:string}>('SELECT model_ids_json FROM model_profiles WHERE name=?',name);
    const legacy=!current||JSON.parse(current.model_ids_json).some((id:string)=>id.startsWith('gpt-4.1'));
    if(legacy)db.prepare('INSERT INTO model_profiles (name,model_ids_json) VALUES (?,?) ON CONFLICT(name) DO UPDATE SET model_ids_json=excluded.model_ids_json').run(name,JSON.stringify(modelIds));
  }
  const insertTask=db.prepare('INSERT OR IGNORE INTO task_model_routes(action,model_id) VALUES(?,?)');
  for(const [action,modelId] of Object.entries(defaultTaskModels))insertTask.run(action,modelId);
}

export function models():ModelDefinition[]{return rows<Record<string,unknown>>('SELECT * FROM model_definitions WHERE enabled=1').map(m=>modelDefinitionSchema.parse({id:m.id,providerId:m.provider_id,label:m.label,protocol:m.protocol,contextWindow:m.context_window,maxOutput:m.max_output,capabilities:JSON.parse(m.capabilities_json as string),priority:m.priority,enabled:Boolean(m.enabled)}));}
export function profiles():ModelProfile[]{return rows<{name:string;model_ids_json:string}>('SELECT * FROM model_profiles').map(p=>modelProfileSchema.parse({name:p.name,modelIds:JSON.parse(p.model_ids_json)}));}
export function taskRoutes():TaskModelRoute[]{return rows<{action:string;model_id:string}>('SELECT action,model_id FROM task_model_routes ORDER BY action').map(item=>taskModelRouteSchema.parse({action:item.action,modelId:item.model_id}));}
export function taskModelId(action:TaskAction):string|undefined{return row<{model_id:string}>('SELECT model_id FROM task_model_routes WHERE action=?',action)?.model_id;}

export function registerSettingsRoutes(app:FastifyInstance):void {
  app.get('/api/settings/models',async()=>{
    const providers=rows<any>('SELECT id,provider_id,label,protocol,base_url,secret_env_name,config_json,enabled FROM model_settings');
    const providerReady=new Map(providers.map(provider=>[provider.provider_id,Boolean(provider.enabled&&process.env[provider.secret_env_name])]));
    return {providers:providers.map(provider=>({...provider,ready:providerReady.get(provider.provider_id)})),models:models().map(model=>({...model,ready:providerReady.get(model.providerId)??false})),profiles:profiles(),taskRoutes:taskRoutes()};
  });
  app.put('/api/settings/providers/:id',async(request,reply)=>{const parsed=z.object({label:z.string().min(1),protocol:z.enum(['openai-responses','chat-completions','openrouter']),baseUrl:z.string().url(),secretEnvName:z.string().regex(/^[A-Z][A-Z0-9_]*$/),enabled:z.boolean(),config:z.record(z.string(),z.unknown()).default({})}).safeParse(request.body);if(!parsed.success)return reply.code(400).send({error:parsed.error.flatten()});const id=(request.params as {id:string}).id;db.prepare(`INSERT INTO model_settings(id,provider_id,label,protocol,base_url,secret_env_name,config_json,enabled) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET label=excluded.label,protocol=excluded.protocol,base_url=excluded.base_url,secret_env_name=excluded.secret_env_name,config_json=excluded.config_json,enabled=excluded.enabled`).run(id,id,parsed.data.label,parsed.data.protocol,parsed.data.baseUrl,parsed.data.secretEnvName,JSON.stringify(parsed.data.config),parsed.data.enabled?1:0);return {ok:true};});
  app.put('/api/settings/models/:id',async(request,reply)=>{const input={...(request.body as object),id:(request.params as {id:string}).id};const parsed=modelDefinitionSchema.safeParse(input);if(!parsed.success)return reply.code(400).send({error:parsed.error.flatten()});const m=parsed.data;db.prepare(`INSERT INTO model_definitions(id,provider_id,label,protocol,context_window,max_output,capabilities_json,priority,enabled) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET provider_id=excluded.provider_id,label=excluded.label,protocol=excluded.protocol,context_window=excluded.context_window,max_output=excluded.max_output,capabilities_json=excluded.capabilities_json,priority=excluded.priority,enabled=excluded.enabled`).run(m.id,m.providerId,m.label,m.protocol,m.contextWindow,m.maxOutput,JSON.stringify(capabilitySchema.parse(m.capabilities)),m.priority,m.enabled?1:0);return {ok:true};});
  app.put('/api/settings/profiles/:name',async(request,reply)=>{const parsed=modelProfileSchema.safeParse({...(request.body as object),name:(request.params as {name:string}).name});if(!parsed.success)return reply.code(400).send({error:parsed.error.flatten()});db.prepare(`INSERT INTO model_profiles(name,model_ids_json) VALUES(?,?) ON CONFLICT(name) DO UPDATE SET model_ids_json=excluded.model_ids_json`).run(parsed.data.name,JSON.stringify(parsed.data.modelIds));return {ok:true};});
  app.put('/api/settings/tasks/:action',async(request,reply)=>{const action=taskActionSchema.safeParse((request.params as {action:string}).action),body=z.object({modelId:z.string().min(1)}).safeParse(request.body);if(!action.success||!body.success)return reply.code(400).send({error:'Invalid task route'});if(!row('SELECT id FROM model_definitions WHERE id=? AND enabled=1',body.data.modelId))return reply.code(422).send({error:'Select an enabled model'});db.prepare('INSERT INTO task_model_routes(action,model_id) VALUES(?,?) ON CONFLICT(action) DO UPDATE SET model_id=excluded.model_id').run(action.data,body.data.modelId);return{ok:true};});
  app.get('/api/settings/prompts', async () => promptTemplateSettings());
  app.put('/api/settings/prompts/:key', async (request, reply) => {
    const body = z.object({ template: z.string().max(50_000) }).safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: body.error.flatten() });
    try {
      savePromptTemplate((request.params as { key: string }).key, body.data.template);
      return { ok: true };
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : 'Invalid prompt template' });
    }
  });
  app.delete('/api/settings/prompts/:key', async (request, reply) => {
    try {
      resetPromptTemplate((request.params as { key: string }).key);
      return { ok: true };
    } catch (error) {
      return reply.code(404).send({ error: error instanceof Error ? error.message : 'Prompt template not found' });
    }
  });
  app.get('/api/settings/behavior', async () => behaviorSettingsResponse());
  app.put('/api/settings/behavior', async (request, reply) => {
    try { return saveContextBehaviorSettings(request.body); }
    catch (error) {
      if (error instanceof z.ZodError) return reply.code(400).send({ error: error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join(' ') });
      throw error;
    }
  });
  app.delete('/api/settings/behavior', async () => resetContextBehaviorSettings());
  app.get('/api/settings/academic-import', async () => academicImportSettingsResponse());
  app.put('/api/settings/academic-import', async (request, reply) => {
    try { return saveAcademicImportSettings(request.body); }
    catch (error) {
      if (error instanceof z.ZodError) return reply.code(400).send({ error: error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join(' ') });
      throw error;
    }
  });
  app.delete('/api/settings/academic-import', async () => resetAcademicImportSettings());
  app.get('/api/settings/providers/:id/catalog',async(request,reply)=>{const setting=providerSetting((request.params as {id:string}).id);if(!setting||setting.protocol!=='openrouter')return reply.code(422).send({error:'Catalog discovery is available for OpenRouter providers'});const key=process.env[setting.secret_env_name];if(!key)return reply.code(422).send({error:`Server secret ${setting.secret_env_name} is not configured`});const response=await fetch(`${setting.base_url}/models`,{headers:{authorization:`Bearer ${key}`}});if(!response.ok)return reply.code(502).send({error:`Catalog returned ${response.status}`});const result=await response.json() as {data?:Array<{id:string;name?:string;context_length?:number;architecture?:unknown;pricing?:unknown}>};return(result.data??[]).map(model=>({id:model.id,label:model.name??model.id,contextWindow:model.context_length??0,architecture:model.architecture,pricing:model.pricing}));});
}
export function providerSetting(providerId:string){return row<{protocol:string;base_url:string;secret_env_name:string;config_json:string;enabled:number}>('SELECT protocol,base_url,secret_env_name,config_json,enabled FROM model_settings WHERE provider_id=?',providerId);}
