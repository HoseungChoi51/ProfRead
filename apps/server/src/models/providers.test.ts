import{afterEach,describe,expect,it,vi}from'vitest';import type{ModelDefinition}from'@afterdraft/shared';import{ChatCompletionsProvider,ResponsesProvider,generateImageWithResponses}from'./providers.js';import{summaryReviewTool}from'./summary-review.js';import{writerProposalTool}from'./writer-context.js';
const model:ModelDefinition={id:'mock',providerId:'mock',label:'Mock',protocol:'openai-responses',contextWindow:10000,maxOutput:100,priority:1,enabled:true,capabilities:{text:true,vision:true,structuredOutput:true,functionTools:true,providerWebSearch:true,reasoningControl:false,imageGeneration:true,streaming:true}};
const response=(chunks:string[])=>new Response(new ReadableStream({start(controller){for(const chunk of chunks)controller.enqueue(new TextEncoder().encode(chunk));controller.close()}}),{status:200});
afterEach(()=>vi.unstubAllGlobals());describe('provider event normalization',()=>{it('normalizes Responses text, usage, and completion',async()=>{vi.stubGlobal('fetch',vi.fn(async()=>response(['event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"Hi"}\n\n','data: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":3,"output_tokens":1}}}\n\n'])));const events=[];for await(const event of new ResponsesProvider('secret',[model]).run({model,messages:[{role:'user',content:'hello'}]}))events.push(event);expect(events).toContainEqual({type:'text_delta',delta:'Hi'});expect(events).toContainEqual({type:'usage',inputTokens:3,outputTokens:1})});it('extracts image data from a Responses image tool call',async()=>{vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify({output:[{type:'image_generation_call',result:'aW1hZ2U='}]}),{status:200})));await expect(generateImageWithResponses('secret','mock','draw it')).resolves.toBe('aW1hZ2U=')});it('normalizes OpenRouter citations and chat deltas',async()=>{vi.stubGlobal('fetch',vi.fn(async()=>response(['data: {"choices":[{"delta":{"content":"Answer"}}],"citations":[{"title":"Source","url":"https://example.test"}]}\n\n','data: [DONE]\n\n'])));const events=[];for await(const event of new ChatCompletionsProvider('secret',[{...model,protocol:'openrouter'}],'https://mock',true).run({model:{...model,protocol:'openrouter'},messages:[{role:'user',content:'hello'}]}))events.push(event);expect(events.some(e=>e.type==='citation')).toBe(true);expect(events).toContainEqual({type:'text_delta',delta:'Answer'})});});

describe('multi-image evidence',()=>{
  it('sends ordered labeled Responses images with explicit detail and disabled storage',async()=>{
    let body:any;vi.stubGlobal('fetch',vi.fn(async(_url:unknown,init?:RequestInit)=>{body=JSON.parse(String(init?.body));return response(['data: {"type":"response.completed","response":{"status":"completed"}}\n\n'])}));
    for await(const event of new ResponsesProvider('secret',[model]).run({model,messages:[{role:'user',content:'audit'}],images:[{id:'crop-1',mimeType:'image/png',data:'YWJj',detail:'high'},{id:'eq-2',mimeType:'image/webp',data:'ZGVm',detail:'original'}],store:false})){void event}
    expect(body.store).toBe(false);expect(body.input[0].content).toEqual([
      {type:'input_text',text:'audit'},
      {type:'input_text',text:'Evidence image crop-1:'},
      {type:'input_image',image_url:'data:image/png;base64,YWJj',detail:'high'},
      {type:'input_text',text:'Evidence image eq-2:'},
      {type:'input_image',image_url:'data:image/webp;base64,ZGVm',detail:'original'},
    ]);
  });
});

describe('forced internal function tools',()=>{
  const tool={name:'propose_document_edits',schema:{type:'object',properties:{version:{const:1}},required:['version'],additionalProperties:false}};
  it('sends and forces an arbitrary function tool through Responses',async()=>{
    let body:any;vi.stubGlobal('fetch',vi.fn(async(_url:unknown,init?:RequestInit)=>{body=JSON.parse(String(init?.body));return response(['data: {"type":"response.output_item.done","item":{"type":"function_call","call_id":"call-1","name":"propose_document_edits","arguments":"{\\"version\\":1}"}}\n\n','data: {"type":"response.completed","response":{"status":"completed"}}\n\n'])}));
    const events=[];for await(const event of new ResponsesProvider('secret',[model]).run({model,messages:[{role:'user',content:'revise'}],tools:[tool],requiredToolName:tool.name}))events.push(event);
    expect(body.tools).toContainEqual({type:'function',name:tool.name,parameters:tool.schema,strict:true});expect(body.tool_choice).toEqual({type:'function',name:tool.name});expect(events).toContainEqual({type:'tool_call',id:'call-1',name:tool.name,input:'{"version":1}'});
  });
  it('sends, forces, and normalizes an arbitrary Chat Completions function tool',async()=>{
    const chatModel={...model,protocol:'chat-completions' as const};let body:any;vi.stubGlobal('fetch',vi.fn(async(_url:unknown,init?:RequestInit)=>{body=JSON.parse(String(init?.body));return response(['data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-2","function":{"name":"propose_document_edits","arguments":"{\\"version\\":1}"}}]}}]}\n\n','data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n','data: [DONE]\n\n'])}));
    const events=[];for await(const event of new ChatCompletionsProvider('secret',[chatModel],'https://mock').run({model:chatModel,messages:[{role:'user',content:'revise'}],tools:[tool],requiredToolName:tool.name}))events.push(event);
    expect(body.tools).toContainEqual({type:'function',function:{name:tool.name,parameters:tool.schema,strict:true}});expect(body.tool_choice).toEqual({type:'function',function:{name:tool.name}});expect(events).toContainEqual({type:'tool_call',id:'call-2',name:tool.name,input:'{"version":1}'});
  });
  it('fails before a provider call when the required tool was not supplied',async()=>{
    const fetchSpy=vi.fn();vi.stubGlobal('fetch',fetchSpy);const provider=new ResponsesProvider('secret',[model]);
    await expect(async()=>{for await(const event of provider.run({model,messages:[{role:'user',content:'revise'}],tools:[],requiredToolName:'missing_tool'})){void event}}).rejects.toThrow('Required function tool is not available');expect(fetchSpy).not.toHaveBeenCalled();
  });
  it('forwards the production strict schemas without rewriting their contract',async()=>{
    let body:any;vi.stubGlobal('fetch',vi.fn(async(_url:unknown,init?:RequestInit)=>{body=JSON.parse(String(init?.body));return response(['data: {"type":"response.completed","response":{"status":"completed"}}\n\n'])}));
    const tools=[writerProposalTool(),summaryReviewTool];for await(const event of new ResponsesProvider('secret',[model]).run({model,messages:[{role:'user',content:'structured work'}],tools})){void event}
    expect(body.tools).toEqual(tools.map(tool=>({type:'function',name:tool.name,parameters:tool.schema,strict:true})));
    for(const tool of body.tools){expect(tool.parameters.type).toBe('object');expect(tool.parameters).not.toHaveProperty('anyOf');expect(JSON.stringify(tool.parameters)).not.toContain('"oneOf"');expect(JSON.stringify(tool.parameters)).not.toContain('"$schema"');expect(JSON.stringify(tool.parameters)).not.toContain('"minLength"');expect(JSON.stringify(tool.parameters)).not.toContain('"maxLength"')}
  });
});

describe('Responses terminal failures',()=>{
  it('throws when a forced tool call is followed by response.failed',async()=>{
    vi.stubGlobal('fetch',vi.fn(async()=>response([
      'data: {"type":"response.output_item.done","item":{"type":"function_call","call_id":"call-failed","name":"propose_document_edits","arguments":"{}"}}\n\n',
      'data: {"type":"response.failed","response":{"error":{"message":"structured generation failed"}}}\n\n',
    ])));const seen:unknown[]=[];
    await expect((async()=>{for await(const event of new ResponsesProvider('secret',[model]).run({model,messages:[{role:'user',content:'revise'}],tools:[writerProposalTool()],requiredToolName:'propose_document_edits'}))seen.push(event)})()).rejects.toThrow('structured generation failed');
    expect(seen).toContainEqual(expect.objectContaining({type:'tool_call',id:'call-failed'}));
  });
  it('throws for incomplete and generic streamed errors',async()=>{
    vi.stubGlobal('fetch',vi.fn(async()=>response(['data: {"type":"response.incomplete","response":{"incomplete_details":{"reason":"max_output_tokens"}}}\n\n'])));
    await expect((async()=>{for await(const event of new ResponsesProvider('secret',[model]).run({model,messages:[{role:'user',content:'revise'}]})){void event}})()).rejects.toThrow('max_output_tokens');
    vi.stubGlobal('fetch',vi.fn(async()=>response(['event: error\ndata: {"type":"error","message":"stream transport failed"}\n\n'])));
    await expect((async()=>{for await(const event of new ResponsesProvider('secret',[model]).run({model,messages:[{role:'user',content:'revise'}]})){void event}})()).rejects.toThrow('stream transport failed');
  });
});

describe('full request context estimates',()=>{
  const tool={name:'review_summary',schema:{type:'object',properties:{decision:{type:'string'},rationale:{type:'string'}},required:['decision','rationale'],additionalProperties:false}};
  const providers=[new ResponsesProvider('secret',[model]),new ChatCompletionsProvider('secret',[{...model,protocol:'chat-completions'}],'https://mock')];
  for(const provider of providers){
    it(`includes schemas and a forced tool choice for ${provider.constructor.name}`,()=>{
      const request={model,messages:[{role:'system' as const,content:'Review safely.'},{role:'user' as const,content:'Review this summary.'}]};
      const base=provider.estimateContext(request),withTool=provider.estimateContext({...request,tools:[tool]}),forced=provider.estimateContext({...request,tools:[tool],requiredToolName:tool.name});
      expect(withTool).toBeGreaterThan(base);expect(forced).toBeGreaterThan(withTool);
    });
    it(`does not discount high-entropy ASCII for ${provider.constructor.name}`,()=>{
      const content=Array.from({length:1_024},(_value,index)=>String.fromCharCode(33+((index*47)%94))).join(''),empty=provider.estimateContext({model,messages:[{role:'user',content:''}]}),filled=provider.estimateContext({model,messages:[{role:'user',content}]});
      expect(filled-empty).toBeGreaterThanOrEqual(Buffer.byteLength(content,'utf8'));
    });
  }
});
