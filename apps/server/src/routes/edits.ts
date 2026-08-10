import type{FastifyInstance}from'fastify';import{z}from'zod';import{editHistory,restoreEdit,saveEdits}from'../edits/index.js';
const operationSchema=z.discriminatedUnion('type',[
  z.object({type:z.literal('replace-text'),blockId:z.string().trim().min(1),text:z.string().max(100_000)}),
  z.object({type:z.literal('format-text'),blockId:z.string().trim().min(1),startOffset:z.number().int().nonnegative(),endOffset:z.number().int().nonnegative(),style:z.enum(['bold','italic','underline']),enabled:z.boolean()}),
  z.object({type:z.literal('fold-section'),blockId:z.string().trim().min(1),folded:z.boolean()}),
  z.object({type:z.literal('set-caption'),blockId:z.string().trim().min(1),label:z.string().trim().max(40),number:z.string().trim().max(40),caption:z.string().trim().max(2_000)})
]);
const saveSchema=z.object({baseRevision:z.number().int().nonnegative(),operations:z.array(operationSchema).min(1).max(200)});
export function registerEditRoutes(app:FastifyInstance):void{
  app.get('/api/versions/:id/edit-history',async(request,reply)=>{try{return editHistory((request.params as{id:string}).id)}catch(error){return reply.code(404).send({error:(error as Error).message})}});
  app.post('/api/versions/:id/edits',async(request,reply)=>{const parsed=saveSchema.safeParse(request.body);if(!parsed.success)return reply.code(400).send({error:parsed.error.flatten()});try{return await saveEdits((request.params as{id:string}).id,parsed.data.baseRevision,parsed.data.operations)}catch(error){return reply.code((error as any).statusCode??400).send({error:(error as Error).message})}});
  app.post('/api/versions/:id/edit-revisions/:revision/restore',async(request,reply)=>{const parsed=z.object({baseRevision:z.number().int().nonnegative()}).safeParse(request.body),revision=Number((request.params as{revision:string}).revision);if(!parsed.success||!Number.isInteger(revision)||revision<0)return reply.code(400).send({error:'Invalid restore request'});try{return await restoreEdit((request.params as{id:string}).id,revision,parsed.data.baseRevision)}catch(error){return reply.code((error as any).statusCode??400).send({error:(error as Error).message})}});
}
