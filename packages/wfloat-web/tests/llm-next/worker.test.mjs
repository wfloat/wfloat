import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
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

test('multi-file load transfers every shard once and transfers WASM separately',async()=>{
 const worker=new WorkerFixture();let transferred;
 const post=worker.postMessage.bind(worker);
 worker.postMessage=(command,transfer)=>{if(command.type==='load')transferred=transfer;post(command);};
 const a=new ArrayBuffer(8),b=new ArrayBuffer(16),wasm=new Uint8Array(4);
 const backend=await createNativeBackend({modelFiles:[{name:'model-00001-of-00002.gguf',data:a},{name:'model-00002-of-00002.gguf',data:b}],wasmBinary:wasm,contextSize:128},worker);
 assert.deepEqual(transferred,[a,b,wasm.buffer]);await backend.unload();
});
const assetsBuild=await build({entryPoints:['src/llm-next/assets.ts'],bundle:true,write:false,format:'esm',platform:'node'});
const {languageModelFiles,getLanguageModelFiles}=await import('data:text/javascript;base64,'+Buffer.from(assetsBuild.outputFiles[0].text).toString('base64'));
test('Gemma manifest selects weights only, sorts shards, and rejects gaps',()=>{
 const files=getLanguageModelFiles('google/gemma-3-1b-it');
 assert.equal(files.length,2);assert.equal(files[0].name,'model-00001-of-00002.gguf');assert.ok(files.every(f=>f.url.endsWith('.gguf')));
 const asset={path:'/model.gguf'};
 assert.deepEqual(languageModelFiles({model_shard_00002:asset,model_terms:{path:'/terms.html'},model_shard_00001:asset}).map(f=>f.name),files.map(f=>f.name));
 assert.throws(()=>languageModelFiles({model_shard_00001:asset,model_shard_00003:asset}),/contiguous/);
 assert.throws(()=>languageModelFiles({model_shard_00001:asset}),/Invalid/);
 assert.throws(()=>languageModelFiles({model:asset,model_shard_00001:asset,model_shard_00002:asset}),/Invalid/);
 assert.equal(getLanguageModelFiles('HuggingFaceTB/SmolLM2-360M-Instruct').length,1);
});

const runtimeBuild=await build({entryPoints:['src/llm-native/runtime.ts'],bundle:true,write:false,format:'esm',platform:'node',plugins:[{name:'fixture-module',setup(b){b.onResolve({filter:/wasm\/wfloat-llama\.js$/},()=>({path:'llama-fixture',namespace:'fixture'}));b.onLoad({filter:/.*/,namespace:'fixture'},()=>({contents:'export const createLlamaModule=async options=>Object.assign(globalThis.__llamaFixture,options);',loader:'js'}));}}]});
const {NativeRuntime}=await import('data:text/javascript;base64,'+Buffer.from(runtimeBuild.outputFiles[0].text).toString('base64'));
function runtimeFixture(fail=false){
 const files=new Map(),strings=new Map(),writes=[],unlinks=[];let pointer=0;
 return {files,writes,unlinks,lengthBytesUTF8:s=>s.length,_malloc:()=>++pointer,_free:()=>{},stringToUTF8:(s,p)=>strings.set(p,s),UTF8ToString:()=> 'bad shard',
 FS:{writeFile:(p,b,o)=>{files.set(p,b);writes.push({p,o});},unlink:p=>{files.delete(p);unlinks.push(p);}},
 _wfloat_native_create:path=>{assert.equal(strings.get(path),'/model-00001-of-00002.gguf');assert.equal(files.size,2);return fail?0:1;},
 _wfloat_native_context_size:()=>128,_wfloat_native_last_error:()=>0,_wfloat_native_destroy:()=>{}
 };
}
test('worker stages all canonical shards before native load and cleans files on success/failure',async()=>{
 for(const fail of [false,true]){
  const fixture=runtimeFixture(fail);globalThis.__llamaFixture=fixture;
  const options={contextSize:128,modelFiles:[{name:'model-00001-of-00002.gguf',data:new ArrayBuffer(8)},{name:'model-00002-of-00002.gguf',data:new ArrayBuffer(8)}]};
  if(fail)await assert.rejects(NativeRuntime.load(options),/bad shard/);else {const runtime=await NativeRuntime.load(options);runtime.unload();}
  assert.equal(fixture.files.size,0);assert.equal(fixture.unlinks.length,2);assert.ok(fixture.writes.every(w=>w.o.canOwn));
 }
 delete globalThis.__llamaFixture;
});
test('worker rejects missing/ambiguous/out-of-order shards before native allocation',async()=>{
 await assert.rejects(NativeRuntime.load({contextSize:128}),/Supply one/);
 await assert.rejects(NativeRuntime.load({contextSize:128,model:new ArrayBuffer(1),modelFiles:[]}),/Supply one/);
 await assert.rejects(NativeRuntime.load({contextSize:128,modelFiles:[{name:'../bad',data:new ArrayBuffer(1)},{name:'second',data:new ArrayBuffer(1)}]}),/ordered/);
});

// Production loader, synthetic registry and tiny buffers: no WASM or inference.
const rolloutIds=['Qwen/Qwen3-0.6B','Qwen/Qwen3-1.7B','Qwen/Qwen3-4B','google/gemma-3-270m-it'];
const rolloutRecords=Object.fromEntries(rolloutIds.map((id,index)=>{
 const count=[1,3,6,1][index],record={family:index===3?'gemma3':'qwen3',model_notice:{path:'/NOTICE.txt'}};
 for(let n=count;n>0;n--)record[count===1?'model':`model_shard_${String(n).padStart(5,'0')}`]={path:`/${id}/${count===1?'model':`part-${n}`}.gguf`,sha256:'a'.repeat(64),sizeBytes:8};
 return [id,record];
}));
rolloutRecords['fixture/composite-speech']={family:'parakeet'};
const rolloutBuild=await build({stdin:{contents:"export {loadLanguageModel} from './src/llm-next/load.ts'; export {getModelRuntimeFamily} from './src/assets/manifest.ts';",resolveDir:process.cwd()},bundle:true,write:false,format:'esm',platform:'node',plugins:[{name:'rollout-fixtures',setup(b){
 const stubs={
  registry:`export const MODEL_ASSETS=${JSON.stringify(rolloutRecords)};export const REGISTRY_ORIGIN='https://fixture.invalid';export const SHARED_ASSETS={};`,
  assets:`export {getModelRuntimeFamily} from './src/assets/manifest.ts';export async function downloadModel(id){globalThis.__rollout.downloads.push(id);}export async function acquireModelAssetLease(){return {signal:new AbortController().signal,async assertCurrent(){},release(){}};}`,
  store:`export async function readAsset(url){globalThis.__rollout.reads.push(url);return new Uint8Array(8);}`,
  urls:`export const LLAMA_WASM_URL='https://fixture.invalid/llama.wasm';`,
  bridge:`export async function createLanguageNativeBackend(options){globalThis.__rollout.loads.push(options);return {contextSize:options.contextSize,async unload(){},async countInputTokens(){return 1;},async *generateRound(){},prepareSchema(s){return s;}};}`
 };
 for(const [filter,path] of [[/generatedModelUrls\.js$/,'registry'],[/^\.\.\/assets\/index\.js$/,'assets'],[/^\.\.\/assets\/store\.js$/,'store'],[/^\.\.\/runtime\/urls\.js$/,'urls'],[/^\.\.\/llm-native\/bridge\.js$/,'bridge']])b.onResolve({filter},()=>({path,namespace:'rollout'}));
 b.onLoad({filter:/.*/,namespace:'rollout'},args=>({loader:'js',resolveDir:process.cwd(),contents:stubs[args.path]}));
}}]});
const rollout=await import('data:text/javascript;base64,'+Buffer.from(rolloutBuild.outputFiles[0].text).toString('base64'));
test('four rollout IDs route to llama with 2048 context and ordered shard transport',async()=>{
 globalThis.__rollout={downloads:[],reads:[],loads:[]};
 try{
  for(const [index,id] of rolloutIds.entries()){
   assert.equal(rollout.getModelRuntimeFamily(id),'llama');
   const m=await rollout.loadLanguageModel(id);assert.equal(m.modelId,id);assert.equal(m.contextSize,2048);
   const load=globalThis.__rollout.loads.at(-1),count=[1,3,6,1][index];
   if(count===1){assert.equal(load.model.byteLength,8);assert.equal(load.modelFiles,undefined);}
   else{assert.equal(load.model,undefined);assert.equal(load.modelFiles.length,count);assert.deepEqual(load.modelFiles.map(f=>f.name),Array.from({length:count},(_,n)=>`model-${String(n+1).padStart(5,'0')}-of-${String(count).padStart(5,'0')}.gguf`));}
   await m.unload();
  }
  assert.deepEqual(globalThis.__rollout.downloads,rolloutIds);
  assert.ok(globalThis.__rollout.reads.every(url=>url.endsWith('.gguf')||url.endsWith('.wasm')));
  assert.equal(rollout.getModelRuntimeFamily('fixture/composite-speech'),'speech');
  await assert.rejects(rollout.loadLanguageModel('fixture/composite-speech'),/not a language model/);
  assert.throws(()=>rollout.getModelRuntimeFamily('Qwen/Qwen3-4B-Q4_K_M'),/Unknown model/);
  const custom=await rollout.loadLanguageModel(rolloutIds[0],{contextSize:1024});assert.equal(custom.contextSize,1024);await custom.unload();
  await assert.rejects(rollout.loadLanguageModel(rolloutIds[0],{contextSize:0}),/positive integer/);
  await assert.rejects(rollout.loadLanguageModel(rolloutIds[0],{numThreads:2}),/single-threaded/);
 }finally{delete globalThis.__rollout;}
});

// Retain Emscripten's config while collecting staging inputs; no WASM/inference.
test('loaded runtime retains URL resolver but releases options and shard buffers',()=>{
 const script = `
 import assert from 'node:assert/strict';
 ${runtimeBuild.outputFiles[0].text}
 const runtimeFixture = ${runtimeFixture.toString()};
 globalThis.__llamaFixture=runtimeFixture();
 async function load() {
  const options={contextSize:128,wasmUrl:'https://fixture.invalid/llama.wasm',modelFiles:[
   {name:'model-00001-of-00002.gguf',data:new ArrayBuffer(8)},
   {name:'model-00002-of-00002.gguf',data:new ArrayBuffer(8)}]};
  const refs=[new WeakRef(options),...options.modelFiles.map(f=>new WeakRef(f.data))];
  const runtime=await NativeRuntime.load(options);
  assert.equal(globalThis.__llamaFixture.files.size,0);
  return {runtime,refs};
 }
 const {runtime,refs}=await load();
 for(let i=0;i<20;i++) {
  await new Promise(resolve=>setImmediate(resolve));
  globalThis.gc();
 }
 assert.ok(refs.every(ref=>ref.deref()===undefined),'load options and shard buffers must be collectable while runtime is alive');
 assert.equal(globalThis.__llamaFixture.locateFile('runtime.wasm'),'https://fixture.invalid/llama.wasm');
 assert.equal(globalThis.__llamaFixture.locateFile('runtime.data'),'runtime.data');
 runtime.unload();
 `;
 execFileSync(process.execPath,['--expose-gc','--input-type=module','-e',script],{timeout:15000,stdio:'pipe'});
});
