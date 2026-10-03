import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
const built = await build({entryPoints:['src/llm-native/bridge.ts'],bundle:true,write:false,format:'esm',platform:'node',define:{'import.meta.url':JSON.stringify(new URL('../../src/llm-native/bridge.ts',import.meta.url).href)}});
const {createNativeBackend,createLanguageNativeBackend} = await import('data:text/javascript;base64,'+Buffer.from(built.outputFiles[0].text).toString('base64'));
class WorkerFixture {
  terminated=0;commands=[];respond=true;
  postMessage(command) {
    this.commands.push(command);
    if(command.type==='load'||command.type==='unload'||(command.type==='count'&&this.respond)) queueMicrotask(()=>this.onmessage({data:{id:command.id,type:'result',value:command.type==='load'?512:10}}));
  }
  terminate(){this.terminated++;}
}
test('unassociated worker errors reject pending requests without permanent invalidation',async()=>{
 const worker=new WorkerFixture();const backend=await createNativeBackend({model:new ArrayBuffer(0),contextSize:512},worker);
 worker.respond=false;const pending=backend.countInputTokens({messages:[]});
 worker.onerror({message:'Unassociated exception'});await assert.rejects(pending,/Unassociated exception/);assert.equal(worker.terminated,0);
 worker.respond=true;assert.equal(await backend.countInputTokens({messages:[]}),10);
 await backend.unload();assert.equal(worker.terminated,1);
});

test('pre-aborted loads reject with AbortError before posting load',async()=>{
 const worker=new WorkerFixture(), controller=new AbortController();controller.abort();
 await assert.rejects(createNativeBackend({model:new ArrayBuffer(0),contextSize:512,signal:controller.signal},worker),{name:'AbortError'});
 assert.equal(worker.commands.length,0);
});

test('load cancellation terminates once and detaches signal after successful load',async()=>{
 const worker=new WorkerFixture(),controller=new AbortController();
 const loading=createNativeBackend({model:new ArrayBuffer(0),contextSize:512,signal:controller.signal},worker);
 controller.abort();await assert.rejects(loading,{name:'AbortError'});assert.equal(worker.terminated,1);
 const other=new WorkerFixture(),signal=new AbortController();
 const backend=await createNativeBackend({model:new ArrayBuffer(0),contextSize:512,signal:signal.signal},other);
 signal.abort();assert.equal(await backend.countInputTokens({messages:[]}),10);assert.equal(other.terminated,0);
 await backend.unload();await backend.unload();assert.equal(other.terminated,1);
});

test('message errors reject both pending RPCs and active iteration without invalidating worker',async()=>{
 const worker=new WorkerFixture(),backend=await createNativeBackend({model:new ArrayBuffer(0),contextSize:512},worker);
 worker.respond=false;
 const iterator=backend.generateRound({messages:[]})[Symbol.asyncIterator]();
 const next=iterator.next(),count=backend.countInputTokens({messages:[]});
 worker.onmessageerror();
 await assert.rejects(next,/could not be decoded/);await assert.rejects(count,/could not be decoded/);
 assert.equal(worker.commands.at(-1).type,'abort');assert.equal(worker.terminated,0);
 worker.respond=true;assert.equal(await backend.countInputTokens({messages:[]}),10);await backend.unload();
});

test('early iterator return waits for native done and rejects overlapping rounds',async()=>{
 const worker=new WorkerFixture(),backend=await createNativeBackend({model:new ArrayBuffer(0),contextSize:512},worker);
 const iterator=backend.generateRound({messages:[]})[Symbol.asyncIterator]();const first=iterator.next();
 const id=worker.commands.at(-1).id;
 worker.onmessage({data:{id,type:'event',event:{type:'text',text:'hi'}}});await first;
 let returned=false;const ending=iterator.return().then(()=>{returned=true;});await Promise.resolve();
 assert.equal(worker.commands.at(-1).type,'abort');assert.equal(returned,false);
 await assert.rejects(backend.generateRound({messages:[]})[Symbol.asyncIterator]().next(),/already active/);
 worker.onmessage({data:{id,type:'event',event:{type:'done',stopReason:'cancelled',inputTokens:1,outputTokens:1,cachedInputTokens:0}}});
 await ending;assert.equal(returned,true);await backend.unload();
});

test('uncloneable generation request releases active round',async()=>{
 const worker=new WorkerFixture(),backend=await createNativeBackend({model:new ArrayBuffer(0),contextSize:512},worker);
 const post=worker.postMessage.bind(worker);worker.postMessage=command=>{if(command.type==='generate')throw new DOMException('Cannot clone','DataCloneError');post(command);};
 await assert.rejects(backend.generateRound({messages:[]})[Symbol.asyncIterator]().next(),{name:'DataCloneError'});
 assert.equal(await backend.countInputTokens({messages:[]}),10);await backend.unload();
});

test('public adapter preserves raw tool history, status feedback, and formatted count request',async()=>{
 const worker=new WorkerFixture(),previous=globalThis.Worker;
 globalThis.Worker=class {constructor(){return worker;}};
 try {
  const backend=await createLanguageNativeBackend({model:new ArrayBuffer(0),contextSize:512});
  const argumentsValue={city:'Boston',quoted:'"line\n你好',nested:{n:2}};
  const request={messages:[
   {role:'user',content:'weather',createdAt:'not-in-prompt'},
   {role:'assistant',content:[{type:'reasoning',text:'think'},{type:'text',text:'Checking.'},{type:'toolCall',id:'000000001',name:'weather',arguments:argumentsValue}]},
   {role:'tool',callId:'000000001',status:'completed',output:{temperature:12}},
   {role:'tool',callId:'000000001',status:'failed',error:{message:'unavailable'}},
   {role:'tool',callId:'000000001',status:'notExecuted'},
   {role:'tool',callId:'000000001',status:'outcomeUnknown'},
  ],tools:{weather:{description:'Weather',inputSchema:{type:'object'}}}};
  const before=structuredClone(request);await backend.countInputTokens(request);
  const normalized=worker.commands.at(-1).request;
  assert.deepEqual(normalized.messages[0],{role:'user',content:'weather'});
  assert.equal(normalized.messages[1].reasoning_content,'think');assert.equal(normalized.messages[1].content,'Checking.');
  assert.deepEqual(JSON.parse(normalized.messages[1].tool_calls[0].function.arguments),argumentsValue);
  assert.deepEqual(normalized.messages.slice(2).map(m=>[m.name,m.tool_call_id,JSON.parse(m.content)]),[
   ['weather','000000001',{temperature:12}],['weather','000000001',{status:'failed',error:{message:'unavailable'}}],
   ['weather','000000001',{status:'notExecuted'}],['weather','000000001',{status:'outcomeUnknown'}],
  ]);
  const iterator=backend.generateRound(request,new AbortController().signal)[Symbol.asyncIterator](),next=iterator.next();
  const command=worker.commands.at(-1);assert.deepEqual(command.request,normalized);
  worker.onmessage({data:{id:command.id,type:'event',event:{type:'toolCall',id:'model-id',name:'weather',rawArguments:'{"city":"Paris"}'}}});
  assert.deepEqual((await next).value,{type:'toolCall',call:{id:'000000002',name:'weather',arguments:{city:'Paris'}}});
  worker.onmessage({data:{id:command.id,type:'event',event:{type:'done',stopReason:'complete',inputTokens:10,outputTokens:3,cachedInputTokens:0}}});
  await iterator.next();await iterator.next();assert.deepEqual(request,before);await backend.unload();
 } finally {globalThis.Worker=previous;}
});

test('abort after load reply but before load promise settles still rejects',async()=>{
 const worker=new WorkerFixture(),controller=new AbortController();
 worker.postMessage=command=>{
  worker.commands.push(command);
  if(command.type==='load')queueMicrotask(()=>{
   worker.onmessage({data:{id:command.id,type:'result',value:512}});
   queueMicrotask(()=>controller.abort());
  });
 };
 await assert.rejects(createNativeBackend({model:new ArrayBuffer(0),contextSize:512,signal:controller.signal},worker),{name:'AbortError'});
 assert.equal(worker.terminated,1);
});
