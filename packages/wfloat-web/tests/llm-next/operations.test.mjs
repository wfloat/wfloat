import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const dir = await mkdtemp(join(tmpdir(), 'wfloat-llm-test-'));
await build({stdin:{contents:"export * from './src/llm-next/model.ts'; export * from './src/llm-next/util.ts'; export {SchemaValidationError} from './src/schema/adapter.ts';",resolveDir:process.cwd()},outfile:join(dir,'model.mjs'),bundle:true,format:'esm',platform:'node'});
const { LanguageModel, StopFilter, SchemaValidationError } = await import(pathToFileURL(join(dir,'model.mjs')));
process.on('exit', () => { void rm(dir,{recursive:true,force:true}); });
const text = text => ({type:'text',text});
const call = (id,name,args) => ({type:'toolCall',call:{id,name,arguments:args}});
const done = (stopReason='complete') => ({type:'done',stopReason,inputTokens:10,outputTokens:3});
const deferred = () => { let resolve;const promise=new Promise(r=>resolve=r);return {resolve,promise}; };
function model(rounds, extras={}) {
  let n=0;
  return new LanguageModel({contextSize:128,async *generateRound(req,signal){const r=rounds[n++]; if(typeof r==='function') yield* r(req,signal);else yield* r;},async countInputTokens(){return 10;},prepareSchema(schema){return {jsonSchema:{type:'object'},parse:async value=>schema?.parse?schema.parse(value):value};},async unload(){},...extras},'fixture');
}
const weather = execute => ({inputSchema:{},execute});
test('handle precedes callbacks and rounds retain text separately',async()=>{
  let handle;const seen=[];
  const m=model([[text('Checking.'),call('a','weather',{}),done()],[text('Sunny.'),done()]]);
  handle=m.generate([{role:'user',content:'Weather?'}],{tools:{weather:weather(()=>({sunny:true}))},onText:t=>{assert.ok(handle);seen.push(t);}});
  const result=await handle.result();await handle.finished;
  assert.equal(result.text,'Sunny.');assert.equal(result.rounds.length,2);assert.deepEqual(seen,['Checking.','Sunny.']);assert.equal(result.usage.inputTokens,20);
  assert.strictEqual(await handle.result(),result);
});
test('manual consumers receive transformed input; history retains raw arguments',async()=>{
 const m=model([[call('a','tool',{value:'42'}),done()]]);
 const result=await m.generate([],{tools:{tool:{inputSchema:{parse:({value})=>({value:Number(value)})}}}}).result();
 assert.equal(result.toolCalls[0].arguments.value,42);assert.equal(result.newMessages[0].content[0].arguments.value,'42');assert.equal(result.stopReason,'toolCalls');assert.equal(result.newMessages.length,1);
});
test('invalid tool requests produce feedback and never execute',async()=>{
 let executed=0,valid=0,invalid=0;
 const m=model([[call('a','tool',{}),done()],[text('Handled'),done()]]);
 const result=await m.generate([],{tools:{tool:{inputSchema:{parse(){throw new SchemaValidationError([{code:'invalidValue',message:'Missing city',instancePath:'',schemaPath:''}]);}},execute(){executed++;return null;}}},onToolCall(){valid++;},onToolValidationError(){invalid++;}}).result();
 assert.equal(executed,0);assert.equal(valid,0);assert.equal(invalid,1);assert.equal(result.newMessages[1].status,'invalidArguments');
});
test('default executor exception is model feedback; stop mode rejects both observers',async()=>{
 const rounds=()=>[[call('a','tool',{}),done()],[text('Unavailable'),done()]];
 const tools={tool:weather(()=>{throw Error('Offline');})};
 const result=await model(rounds()).generate([],{tools}).result();assert.equal(result.stopReason,'complete');assert.equal(result.newMessages[1].status,'failed');
 const op=model(rounds()).generate([],{tools,toolErrorBehavior:'stop'});
 await assert.rejects(op.result(),e=>e.name==='GenerationError'&&e.cause.message==='Offline');await assert.rejects(op.finished,/Offline/);
});
test('unsupported executor output is fatal even in continue mode',async()=>{
 const op=model([[call('a','tool',{}),done()]]).generate([],{tools:{tool:weather(()=>undefined)}});
 await assert.rejects(op.result(),/JSON/);
});
test('parallel callback completion order differs from stable history order',async()=>{
 const a=deferred(),b=deferred(),started=deferred();let count=0;const events=[];
 const op=model([[call('a','tool',{n:1}),call('b','tool',{n:2}),done()],[text('done'),done()]]).generate([],{tools:{tool:weather(({n})=>n===1?a.promise:b.promise)},toolExecution:'parallel',onToolStart(){if(++count===2)started.resolve();},onToolResult:({call})=>events.push(call.id)});
 await started.promise;b.resolve(2);await new Promise(r=>setTimeout(r,0));a.resolve(1);
 const result=await op.result();assert.deepEqual(events,['b','a']);assert.deepEqual(result.newMessages.filter(m=>m.role==='tool').map(m=>m.callId),['a','b']);
});
test('cancel does not wait for an uncooperative tool and late result cannot mutate snapshot',async()=>{
 const work=deferred(),started=deferred(),late=deferred();
 const op=model([[call('a','tool',{}),done()]]).generate([],{tools:{tool:weather(()=>work.promise)},onToolStart(){started.resolve();},onToolResult(){late.resolve();}});
 await started.promise;op.cancel();const result=await op.result();assert.equal(result.stopReason,'cancelled');assert.equal(result.newMessages[1].status,'outcomeUnknown');
 work.resolve({ok:true});await late.promise;assert.equal(result.newMessages[1].status,'outcomeUnknown');
});
test('stop string drains already queued tools but does not start another model round',async()=>{
 const seen=[];const op=model([[call('a','tool',{}),text('Hello EN'),text('D extra'),done()]]).generate([],{tools:{tool:weather(()=>{seen.push('tool');return null;})},toolExecutionTiming:'afterGeneration',stopStrings:['END']});
 const result=await op.result();assert.equal(result.text,'Hello ');assert.equal(result.stopReason,'stopString');assert.deepEqual(seen,['tool']);assert.equal(result.rounds.length,1);
});
test('correction rounds reset text and validation exhaustion rejects',async()=>{
 const schema={parse(v){if(typeof v.n!=='number')throw new SchemaValidationError([{code:'invalidValue',message:'n must be a number',instancePath:'',schemaPath:''}]);return v;}};
 const op=model([[text('{"n":"bad"}'),done()],[text('{"n":1}'),done()]]).generate([],{structuredOutput:{schema,maxCorrectionAttempts:1}});
 const result=await op.result();assert.deepEqual(result.output,{n:1});assert.equal(result.rounds.length,2);
 await assert.rejects(model([[text('{"n":"bad"}'),done()]]).generate([],{structuredOutput:{schema}}).result(),/n must/);
});
test('early token limit with valid JSON returns output; invalid partial does not reject',async()=>{
 const good=await model([[text('{"n":1}'),done('maxTokens')]]).generate([],{structuredOutput:{schema:{}}}).result();assert.deepEqual(good.output,{n:1});
 const partial=await model([[text('{"n":'),done('maxTokens')]]).generate([],{structuredOutput:{schema:{}}}).result();assert.equal(partial.stopReason,'maxTokens');assert.equal(partial.output,undefined);
});
test('whole-operation FIFO does not let another generation bypass managed tools',async()=>{
 const started=deferred(),work=deferred();let second=false;
 const m=model([[call('a','tool',{}),done()],[text('first complete'),done()],[text('second'),done()]]);
 const a=m.generate([],{tools:{tool:weather(()=>work.promise)},onToolStart(){started.resolve();}});
 const b=m.generate([],{onRoundStart(){second=true;}});await started.promise;assert.equal(second,false);work.resolve(null);await a.result();assert.equal((await b.result()).text,'second');
});
test('split marker matching and channel boundary flushing',()=>{
 const f=new StopFilter(['END']);assert.equal(f.push('abE'),'ab');assert.equal(f.push('N'),'');assert.equal(f.push('Ddiscard'),'');assert.equal(f.stopped,true);
 const g=new StopFilter(['END']);assert.equal(g.push('E'),'');assert.equal(g.flush(),'E');assert.equal(g.push('ND'),'ND');assert.equal(g.stopped,false);
});
test('queued cancellation resolves without waiting for active user tool',async()=>{
 const started=deferred(),work=deferred();
 const m=model([[call('a','tool',{}),done()],[text('first'),done()]]);
 const first=m.generate([],{tools:{tool:weather(()=>work.promise)},onToolStart(){started.resolve();}});
 const second=m.generate([]);await started.promise;second.cancel();
 const result=await Promise.race([second.result(),new Promise((_,reject)=>setTimeout(()=>reject(Error('queued cancel stuck')),100))]);
 assert.equal(result.stopReason,'cancelled');assert.equal(result.durationMs,0);work.resolve(null);await first.result();
});
test('callback failures do not fail healthy work or block on notification promises',async()=>{
 const original=console.error,errors=[];console.error=(...args)=>errors.push(args);
 try {
 const never=new Promise(()=>{});
 const op=model([[text('a'),text('b'),done()]]).generate([],{onText:t=>{if(t==='a')throw Error('UI bug');return never;}});
 assert.equal((await op.result()).text,'ab');assert.equal(errors.length,1);
 } finally { console.error=original; }
});
test('all schema preflights complete before any inference and bad preflight fails',async()=>{
 let generated=false;
 const m=model([async function*(){generated=true;yield done();}],{prepareSchema:async()=>{throw Error('Unsupported schema');}});
 await assert.rejects(m.generate([],{tools:{tool:{inputSchema:{unsupported:true}}}}).result(),/Unsupported schema/);assert.equal(generated,false);
});
test('validator runtime failure is not presented as bad model arguments',async()=>{
 let feedback=0;
 const m=model([[call('a','tool',{}),done()]]);
 await assert.rejects(m.generate([],{tools:{tool:{inputSchema:{parse(){throw Error('worker crashed');}},execute(){return null;}}},onToolValidationError(){feedback++;}}).result(),/worker crashed/);
 assert.equal(feedback,0);
});
test('maxRounds blocks remaining corrections without claiming validation exhaustion',async()=>{
 const warnings=[];const original=console.warn;console.warn=(...args)=>warnings.push(args);
 try {
 const r=await model([[text('not JSON'),done()]]).generate([],{maxRounds:1,structuredOutput:{schema:{},maxCorrectionAttempts:2}}).result();
 assert.equal(r.stopReason,'maxRounds');assert.equal(r.output,undefined);assert.equal(warnings.length,1);
 } finally {console.warn=original;}
});
test('cancelling inference settles before cleanup but the next operation waits for cleanup',async()=>{
 const emitted=deferred(),cleanup=deferred();let enteredSecond=false;
 const m=model([async function*(_request,signal){try {yield text('partial');emitted.resolve();await new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}));}finally{await cleanup.promise;}},async function*(){enteredSecond=true;yield text('next');yield done();}]);
 const first=m.generate([]),second=m.generate([]);await emitted.promise;first.cancel();
 assert.equal((await first.result()).stopReason,'cancelled');assert.equal(enteredSecond,false);cleanup.resolve();assert.equal((await second.result()).text,'next');
});
test('cancel from round start never starts inference',async()=>{
 let starts=0,op;
 const m=model([async function*(){starts++;yield done();}]);op=m.generate([],{onRoundStart(){op.cancel();}});
 assert.equal((await op.result()).stopReason,'cancelled');assert.equal(starts,0);
});
test('cancel from tool start never invokes the executor',async()=>{
 let starts=0,op;
 op=model([[call('a','tool',{}),done()]]).generate([],{tools:{tool:weather(()=>{starts++;return null;})},onToolStart(){op.cancel();}});
 assert.equal((await op.result()).stopReason,'cancelled');assert.equal(starts,0);
});
test('cancel returns held unmatched marker prefix',async()=>{
 const emitted=deferred();
 const op=model([async function*(_,signal){yield text('Hello <EN');emitted.resolve();await new Promise(r=>signal.addEventListener('abort',r,{once:true}));}]).generate([],{stopStrings:['<END>']});
 await emitted.promise;op.cancel();assert.equal((await op.result()).text,'Hello <EN');
});
test('stopWhen prevents structured correction and valid cancelled text is parsed',async()=>{
 const stopped=await model([[text('bad JSON'),done()]]).generate([],{structuredOutput:{schema:{},maxCorrectionAttempts:1},stopWhen:()=>true}).result();assert.equal(stopped.stopReason,'stopCondition');
 let op;op=model([[text('{"n":1}'),done()]]).generate([],{structuredOutput:{schema:{}},onText(){op.cancel();}});
 const result=await op.result();assert.equal(result.stopReason,'cancelled');assert.deepEqual(result.output,{n:1});
});
test('callback cancellation never invokes a second iterator next',async()=>{
 let calls=0,op;
 const m=model([],{generateRound(){return {[Symbol.asyncIterator](){return {next(){calls++;return calls===1?Promise.resolve({done:false,value:text('hi')}):Promise.reject(Error('must never invoke'));},return:async()=>({done:true})};}};}});
 op=m.generate([],{onText(){op.cancel();}});assert.equal((await op.result()).stopReason,'cancelled');assert.equal(calls,1);
});
test('cancel reuses an in-flight schema transformation exactly once',async()=>{
 const started=deferred(),parsed=deferred();let calls=0;
 const schema={parse(){calls++;started.resolve();return parsed.promise;}};
 const op=model([[text('{"n":1}'),done()]]).generate([],{structuredOutput:{schema}});
 await started.promise;op.cancel();parsed.resolve({n:2});
 const result=await op.result();assert.equal(calls,1);assert.equal(result.stopReason,'cancelled');assert.deepEqual(result.output,{n:2});
});
test('stopWhen must return a boolean rather than a truthy accidental value',async()=>{
 await assert.rejects(model([[text('answer'),done()]]).generate([],{stopWhen:()=> 'false'}).result(),/stopWhen must return a boolean/);
});
test('long streams do not retain one cancellation race per backend event',async()=>{
 const {spawnSync}=await import('node:child_process');
 const script=`
 import {LanguageModel} from ${JSON.stringify(pathToFileURL(join(dir,'model.mjs')).href)};
 let resume,ready;const gate=new Promise(r=>resume=r),reached=new Promise(r=>ready=r);
 const model=new LanguageModel({contextSize:1000,async *generateRound(){
   for(let i=0;i<50000;i++)yield {type:'usage',inputTokens:1,outputTokens:i};
   ready();await gate;yield {type:'done',stopReason:'complete',inputTokens:1,outputTokens:50000};
 },async countInputTokens(){return 0;},prepareSchema(){},async unload(){}},'fixture');
 global.gc();const before=process.memoryUsage().heapUsed;
 const op=model.generate([]);await reached;global.gc();
 const retained=process.memoryUsage().heapUsed-before;
 resume();await op.result();await model.unload();
 // Previously ~40 MiB of pending Promise.race reactions, without retained text.
 if(retained>12*1024*1024)throw Error('Retained '+retained+' bytes for completed waits');
 `;
 const child=spawnSync(process.execPath,['--expose-gc','--input-type=module','-e',script],{encoding:'utf8',timeout:15000});
 assert.equal(child.status,0,child.stderr||String(child.error));
});
test('parallel failing executor in stop mode signals siblings and leaves queue recoverable',async()=>{
 const started=deferred(),failure=deferred(),late=deferred();const events=[];let active=0;
 const m=model([[call('a','tool',{n:1}),call('b','tool',{n:2}),call('c','tool',{n:3}),done()],[text('recovered'),done()]]);
 const first=m.generate([],{toolExecution:'parallel',maxConcurrentTools:2,toolErrorBehavior:'stop',tools:{tool:weather(async({n},{signal})=>{
   active++;if(active===2)started.resolve();
   if(n===1){await failure.promise;throw Error('executor failure');}
   if(n===2){await new Promise(r=>signal.addEventListener('abort',r,{once:true}));throw signal.reason;}
   throw Error('queued call should not execute');
 })},onToolStart:({call})=>events.push(call.id),onToolCancel(){late.resolve();}});
 const next=m.generate([]);await started.promise;failure.resolve();
 await assert.rejects(first.result(),e=>{assert.equal(e.partialResult.newMessages.find(m=>m.callId==='a').status,'failed');return /executor failure/.test(e.message);});
 await late.promise;assert.equal((await next.result()).text,'recovered');assert.deepEqual(events,['a','b']);
});
test('manual early jobs receive parsed calls once without delaying result',async()=>{
 const work=deferred(),jobs=new Map();
 const op=model([[call('a','tool',{value:'42'}),text('Requested.'),done()]]).generate([],{tools:{tool:{inputSchema:{parse:({value})=>({value:Number(value)})}}},onToolCall:({call})=>{assert.equal(call.arguments.value,42);jobs.set(call.id,work.promise);return work.promise;}});
 const r=await op.result();assert.equal(r.stopReason,'toolCalls');assert.equal(jobs.size,1);assert.equal(r.newMessages.length,1);assert.equal(r.toolCalls[0].id,'a');
 work.resolve(42);assert.equal(await jobs.get('a'),42);
});
test('cancellation during asynchronous tool validation preserves a non-executed outcome',async()=>{
 const validating=deferred(),parsed=deferred();let executed=0,notified=0;
 const op=model([[call('a','tool',{value:'42'}),done()]]).generate([],{tools:{tool:{inputSchema:{parse(){validating.resolve();return parsed.promise;}},execute(){executed++;return null;}}},onToolCall(){notified++;}});
 await validating.promise;op.cancel();const result=await op.result();
 assert.equal(result.stopReason,'cancelled');assert.equal(result.newMessages[1]?.status,'notExecuted');
 assert.equal(result.newMessages[1]?.callId,'a');assert.equal(result.toolCalls.length,0);
 parsed.resolve({value:42});await new Promise(r=>setTimeout(r,0));assert.equal(executed,0);assert.equal(notified,0);
});
test('tool draining obeys all scheduling modes at token/context/stop-string boundaries',async()=>{
 for(const toolExecution of ['sequential','parallel'])for(const toolExecutionTiming of ['immediate','afterGeneration'])for(const reason of ['maxTokens','contextLimit','stopString']){
  let running=0,peak=0;const completed=[];
  const end=reason==='stopString'?[text('answer STOP discard'),done()]:[done(reason)];
  const tools={tool:weather(async({n})=>{running++;peak=Math.max(peak,running);await new Promise(r=>setTimeout(r,2));running--;completed.push(n);return n;})};
  const m=model([[call('a','tool',{n:1}),call('b','tool',{n:2}),call('c','tool',{n:3}),...end]]);
  const result=await m.generate([],{tools,toolExecution,toolExecutionTiming,...(toolExecution==='parallel'?{maxConcurrentTools:2}:{}),stopStrings:['STOP']}).result();
  assert.equal(result.stopReason,reason);assert.equal(result.rounds.length,1);assert.equal(completed.length,3);assert.ok(peak<=(toolExecution==='parallel'?2:1));
  assert.deepEqual(result.newMessages.filter(m=>m.role==='tool').map(m=>[m.callId,m.status]),[['a','completed'],['b','completed'],['c','completed']]);
  await m.unload();
 }
});
test('cancellation from tool-call callback keeps accepted call unstarted and prevents next-round work',async()=>{
 let op,executed=0,started=0;
 op=model([[call('a','tool',{}),text('after call'),done()]]).generate([],{tools:{tool:weather(()=>{executed++;return null;})},onToolCall(){op.cancel();},onToolStart(){started++;}});
 const result=await op.result();assert.equal(result.stopReason,'cancelled');assert.equal(result.newMessages[1].status,'notExecuted');assert.equal(result.toolCalls.length,1);assert.equal(executed,0);assert.equal(started,0);
});
test('cancelled stopWhen never resumes inference when its answer arrives later',async()=>{
 const entered=deferred(),decision=deferred();let rounds=0;
 const op=model([[call('a','tool',{}),done()]]).generate([],{tools:{tool:weather(()=>null)},onRoundStart(){rounds++;},stopWhen(){entered.resolve();return decision.promise;}});
 await entered.promise;op.cancel();const result=await op.result();decision.resolve(false);await new Promise(r=>setTimeout(r,0));
 assert.equal(result.stopReason,'cancelled');assert.equal(rounds,1);assert.equal(result.newMessages[1].status,'completed');
});
test('malformed saved history is rejected before scheduling rather than silently dropped',()=>{
 const m=model([]);
 for(const message of [
  {role:'assistant',content:[{type:'typo',text:'lost content'}]},
  {role:'assistant',content:[{type:'text',text:42}]},
  {role:'assistant',content:[{type:'toolCall',name:'weather',arguments:{}}]},
  {role:'tool',callId:'a',status:'typo'},
  {role:'tool',status:'completed',output:null},
  {role:'tool',callId:'a',status:'failed',error:{message:42}},
 ])assert.throws(()=>m.generate([message]),TypeError);
});
test('stop matching is invariant to token-fragment boundaries',()=>{
 // Compare against first completed character-level match, including overlaps,
 // retained unfinished prefixes, and UTF-16 splits inside an emoji.
 const cases=[
  ['before ENDING after',['END','ENDING']],
  ['before abc after',['bc','abc']],
  ['before ababab after',['abab','bab']],
  ['before <END',['<END>']],
  ['before 🌍 after',['🌍']],
  ['ordinary text',[]],
 ];
 for(const [input,stops] of cases){
  let expected=input,stopped=false;
  for(let end=1;end<=input.length&&!stopped;end++)for(const marker of stops){
   if(input.slice(0,end).endsWith(marker)){expected=input.slice(0,end-marker.length);stopped=true;break;}
  }
  for(let width=1;width<=input.length;width++){
   const filter=new StopFilter(stops);let actual='';
   for(let i=0;i<input.length;i+=width)actual+=filter.push(input.slice(i,i+width));
   actual+=filter.flush();assert.equal(actual,expected,JSON.stringify({input,stops,width}));assert.equal(filter.stopped,stopped);
  }
 }
});
