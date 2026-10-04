/** Run the checked web orchestration tests against RN modules, substituting only
 * the native transport. Browser-specific tests remain in the web test suite.
 * From the repository root (after installing web and RN package dependencies):
 * node --test packages/react-native-wfloat/src/next/llm-next/__tests__/portable.test.mjs
 * The Hermes subprocess uses RN 0.76's bundled macOS Hermes executable.
 */
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';
const root = fileURLToPath(new URL('../../../../../../', import.meta.url));
const require = createRequire(resolve(root, 'packages/wfloat-web/package.json'));
const { build } = require('esbuild');
const ts = require('typescript');
const rn = resolve(root, 'packages/react-native-wfloat/src/next');
let serial = 0;
const listeners = new Map();
const calls = [];
let respond = async command => { throw Error(`Unexpected native call: ${command.op}`); };
globalThis.__wfloatTestTransport = {
  request(command, options) { calls.push(command); return respond(command, options); },
  subscribe(id, cb) { listeners.set(id, cb); return () => listeners.delete(id); },
  uniqueId(prefix) { return `${prefix}-${++serial}`; },
};
const native = { name: 'native-test-transport', setup(b) {
  b.onResolve({filter: /platform\/bridge(?:\.js)?$/}, () => ({path:'bridge',namespace:'native-test'}));
  b.onLoad({filter: /.*/,namespace:'native-test'}, () => ({contents:`
    export const request=(...args)=>globalThis.__wfloatTestTransport.request(...args);
    export const subscribe=(...args)=>globalThis.__wfloatTestTransport.subscribe(...args);
    export const uniqueId=(...args)=>globalThis.__wfloatTestTransport.uniqueId(...args);
    export const abortError=()=>Object.assign(new Error('Operation aborted'),{name:'AbortError'});
    export function checkAbort(signal){if(signal?.aborted)throw signal.reason??abortError();}
    export const notify=(fn,event)=>fn?.(event);
  `,loader:'js'}));
  b.onResolve({filter:/^react-native$/}, () => ({path:'rn',namespace:'rn-test'}));
  b.onLoad({filter:/.*/,namespace:'rn-test'}, () => ({contents:`export const AppState={addEventListener(){return {remove(){}};}};
    export const Platform={OS:'android'};
    export const PermissionsAndroid={
      PERMISSIONS:{RECORD_AUDIO:'android.permission.RECORD_AUDIO'},
      RESULTS:{GRANTED:'granted',DENIED:'denied',NEVER_ASK_AGAIN:'never_ask_again'},
      async check(){return true;},
      async request(){return 'granted';}
    };`,loader:'js'}));
}};
globalThis.__wfloatTestBuild = options => build({...options, plugins:[native]});
async function bundle(contents) {
  const out = await build({stdin:{contents,resolveDir:rn,loader:'ts'},bundle:true,write:false,format:'esm',platform:'node',plugins:[native]});
  return 'data:text/javascript;base64,'+Buffer.from(out.outputFiles[0].text).toString('base64');
}
async function replay(path, exports, marker, disallow = /$^/) {
  const original = await readFile(resolve(root,'packages/wfloat-web/tests',path),'utf8');
  const body = original.slice(original.indexOf(marker)).replace(/new URL\('\.\.\/\.\.\/src\/([^']+)', import\.meta\.url\)\.pathname/g, (_, file) => JSON.stringify(resolve(rn, file)));
  const ast = ts.createSourceFile(path,body,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
  const statements = ast.statements.filter(node => !disallow.test(node.getText(ast)));
  const module = await bundle(exports);
  const names = path.startsWith('llm') ? 'LanguageModel, StopFilter, SchemaValidationError' : path.startsWith('tts') ? 'TextToSpeechModel, validateWfloatSegment' : path.startsWith('stt') ? (path.includes('audio.') ? 'snapshotAudio, snapshotPcm, normalizeAudio, StreamingResampler' : 'SpeechToTextModel, StreamingSpeechToTextModel, SttModelOwner') : 'VoiceActivityDetectionModel:Model, Segmenter, configuration';
  const code = `import assert from 'node:assert/strict'; import test from 'node:test'; import vm from 'node:vm'; const build=globalThis.__wfloatTestBuild; const {${names}}=await import(${JSON.stringify(module)});\n`+statements.map(n=>n.getText(ast)).join('\n');
  await import('data:text/javascript;base64,'+Buffer.from(code).toString('base64'));
}
await replay('llm-next/operations.test.mjs', `export * from './llm-next/model.ts';export * from './llm-next/util.ts';export {SchemaValidationError} from './schema/adapter.ts';`, 'const text =', /spawnSync/);
await replay('tts-next/tts-next.test.mjs', `export * from './tts-next/model.ts';export * from './tts-next/backend.ts';`, 'const sleep =', /WebAudioPlayback|AudioContext|SherpaTextToSpeechBackend|installEspeak|ensureHeapViews/);
await replay('stt-next/operations.test.mjs', `export * from './stt-next/model.ts';`, 'const gate =', /AudioContext|new Blob|new File|AudioBuffer|getChannelData/);
await replay('stt-next/audio.test.mjs', `export * from './stt-next/audio.ts';`, "test('PCM ownership", /AudioBuffer|new Blob/);
await replay('vad-next/operations.test.mjs', `export * from './vad-next/model.ts';export * from './vad-next/segmenter.ts';`, 'const turn=');

const { NativePlayback } = await import(await bundle(`export * from './tts-next/playback.ts';`));
const { snapshotAudio, normalizeAudio } = await import(await bundle(`export * from './stt-next/audio.ts';`));
const { createNativeBackend } = await import(await bundle(`export * from './llm-native/bridge.ts';`));
test('native URI input snapshots identity and uses bridge decoding before resampling', async () => {
  calls.length=0;
  respond=async c=>{assert.equal(c.op,'decodeAudio');assert.equal(c.uri,'content://audio/1');return {samples:[.25,.5],sampleRate:16000};};
  const input={uri:'content://audio/1'};const snapshot=snapshotAudio(input);input.uri='file:///changed';
  const pcm=await normalizeAudio(snapshot);assert.deepEqual([...pcm.samples],[.25,.5]);
  assert.throws(()=>snapshotAudio({uri:'https://remote/audio'}),/remote fetching/);
});
test('native playback forwards policy, retains queued samples on resume, and uses native position', async () => {
  calls.length=0;let position=0;
  respond=async c=>c.op==='playbackPosition'?position:null;
  const states=[];const driver=new NativePlayback({audioFocus:'duckOthers',backgroundBehavior:'pauseAndAutoResume'},s=>states.push(s));
  const chunks=[{startMs:0,audio:{samples:new Float32Array(1600).fill(.25),sampleRate:16000},timeline:[]}];
  await driver.start(chunks,0);
  assert.deepEqual(calls.find(c=>c.op==='playbackStart').options,{audioFocus:'duckOthers',backgroundBehavior:'pauseAndAutoResume'});
  position=32;
  [...listeners.values()][0]({type:'playbackState',state:'paused'});
  await new Promise(r=>setTimeout(r,5));
  assert.equal(driver.positionMs(),32);assert.deepEqual(states,['paused']);
  assert.ok(!calls.some(c=>c.op==='playbackPause'));
  driver.stop();await driver.start(chunks,32);
  assert.equal(calls.filter(c=>c.op==='playbackStart')[1].samples.length,0);
  assert.ok(!calls.some(c=>c.op==='playbackAppend'));
  await driver.dispose();assert.equal(listeners.size,0);
});
test('native round early iterator return cancels and drains before allowing another round',async()=>{
  let cancelled=false;
  respond=async(c,options)=>{
    if(c.op==='load')return {contextSize:128};
    if(c.op==='generateRound')return new Promise(resolve=>{
      options.onEvent({type:'text',text:'first'});
      options.signal.addEventListener('abort',()=>{cancelled=true;resolve(null);},{once:true});
    });
    return null;
  };
  const backend=await createNativeBackend({modelId:'fixture',paths:{model:'fixture.gguf'},contextSize:128});
  for await(const event of backend.generateRound({messages:[]})){assert.equal(event.text,'first');break;}
  assert.equal(cancelled,true);await backend.unload();
});
const { TextToSpeechModel } = await import(await bundle(`export * from './tts-next/model.ts';`));
const turn = () => new Promise(resolve => setImmediate(resolve));
const gate = () => { let resolve; const promise=new Promise(r=>{resolve=r;}); return {promise,resolve}; };
async function until(predicate) { for(let i=0;i<100;i++){if(predicate())return;await turn();}assert.fail('Transition did not happen'); }
function pausedFixture(retained) {
  const blocked=gate();let syntheses=0;let onState;const observations=[];
  const backend={sampleRate:16000,validate(){},async prepare(){return [{text:'a',textStart:0,textEnd:1},{text:'b',textStart:1,textEnd:2},{text:'c',textStart:2,textEnd:3}];},async synthesize(){if(++syntheses===2)await blocked.promise;return {samples:new Float32Array(16000),sampleRate:16000};},async unload(){}};
  let stops=0;
  const model=new TextToSpeechModel(backend,(options,callback)=>{onState=callback;observations.push(options);return {async start(){},append(){},positionMs(){return 0;},stop(){stops++;},close(){}};});
  const generation=retained?model.generate('abc'):undefined;
  const speech=generation?generation.speak({backgroundBehavior:'pauseAndAutoResume'}):model.speak('abc',{backgroundBehavior:'pauseAndAutoResume'});
  return {model,generation,speech,blocked,get syntheses(){return syntheses;},get stops(){return stops;},get onState(){return onState;},observations};
}
test('OS pause suspends direct TTS generation at the next safe boundary without clearing native auto-resume',async()=>{
  const f=pausedFixture(false);await until(()=>f.syntheses===2);
  f.onState('paused');f.blocked.resolve();await turn();await turn();
  assert.equal(f.syntheses,2);assert.equal(f.stops,0);
  assert.equal(f.observations[0].backgroundBehavior,'pauseAndAutoResume');
  f.onState('resumed');await until(()=>f.syntheses===3);f.speech.cancel();await f.model.unload();
});
test('OS pause of generation.speak preserves separately owned generation scheduling',async()=>{
  const f=pausedFixture(true);await until(()=>f.syntheses===2);
  f.onState('paused');f.blocked.resolve();await f.generation.finished;
  assert.equal(f.syntheses,3);assert.equal(f.stops,0);f.speech.cancel();await f.model.unload();
});
const { LiveSession }=await import(await bundle(`export * from './stt-next/session.ts';`));
test('session microphone resume reuses original capture and a resume failure preserves partial result semantics',async()=>{
  let starts=0, allocations=0, original;const resumed=Error('resume failed');
  const backend={kind:'offline'};
  const session=new LiveSession(backend,{},()=>{},async(_audio,_error,_signal,options)=>{
    allocations++;original=options;return {async start(){starts++;if(starts===2)throw resumed;},async stop(){}};
  });
  await session.startMicrophone({voiceProcessing:true,backgroundBehavior:'pauseUntilResumed'});
  await session.startMicrophone({voiceProcessing:false});
  assert.equal(allocations,1);assert.equal(starts,1);assert.equal(original.voiceProcessing,true);
  await assert.rejects(session.startMicrophone(),/resume failed/);
  await assert.rejects(session.result(),e=>e.partialResult.text===''&&e.cause===resumed);
});
const { NativeTextToSpeechBackend }=await import(await bundle(`export * from './tts-next/backend.ts';`));
test('native TTS prepares emotion tags once and synthesizes prepared text with voice and speed',async()=>{
  const calls=[];
  const instance={async call(op,fields){calls.push({op,...fields});return op==='prepare'?[{text:'<joy>prepared',textStart:0,textEnd:5}]:{sampleRate:16000,samples:[.25]};},async unload(){}};
  const backend=new NativeTextToSpeechBackend(instance,16000);
  const segment={text:'Hello',emotion:'joy',intensity:.8,voiceId:'wise_elder_woman',speed:1.5};
  const [unit]=await backend.prepare(segment);await backend.synthesize(unit,segment);
  assert.deepEqual(calls,[{op:'prepare',text:'Hello',emotion:'joy',intensity:.8},{op:'synthesize',text:'<joy>prepared',voiceId:13,speed:1.5}]);
});
test('invalid native playback policy rejects before creating or interrupting speech',async()=>{
  const f=pausedFixture(false);await until(()=>f.syntheses===2);
  assert.throws(()=>f.model.speak('abc',{backgroundBehavior:'wrong'}),/backgroundBehavior/);
  assert.throws(()=>f.model.speak('abc',{audioFocus:'wrong'}),/audioFocus/);
  assert.equal(f.stops,0);f.blocked.resolve();f.speech.cancel();await f.model.unload();
});

test('RN 0.76 Hermes executes Babel async-generator LLM rounds and public TTS audio without Symbol.asyncIterator',async()=>{
  const {spawnSync}=await import('node:child_process');
  const rnRequire=createRequire(resolve(root,'packages/react-native-wfloat/package.json'));
  const babel=rnRequire('@babel/core');
  const entry=`
    import {LanguageModel} from './llm-next/model';
    import {TextToSpeechModel} from './tts-next/model';
    import {createLanguageNativeBackend} from './llm-native/bridge';
    function check(ok,message){if(!ok)throw new Error(message);}
    async function main(){
      check(Symbol.asyncIterator===undefined,'Regression must run on Hermes without Symbol.asyncIterator');
      const native=await createLanguageNativeBackend({modelId:'fixture',paths:{model:'test.gguf'},contextSize:128});
      const model=new LanguageModel({...native,prepareSchema(){throw new Error('unused');}},'fixture');
      const result=await model.generate([{role:'user',content:'hello'}]).result();
      check(result.text==='Hermes works','Native LLM round failed');
      check(result.stopReason==='complete','Unexpected LLM stop reason');
      await model.unload();
      let op;
      const cancelling=new LanguageModel({contextSize:128,async countInputTokens(){return 1;},prepareSchema(){throw new Error('unused');},async unload(){},async *generateRound(){yield {type:'text',text:'cancel'};await new Promise(()=>{});}},'fixture');
      op=cancelling.generate([],{onText(){op.cancel();}});
      check((await op.result()).stopReason==='cancelled','Hermes cancellation failed');
      const tts=new TextToSpeechModel({sampleRate:16000,validate(){},async prepare(){return [{text:'a',textStart:0,textEnd:1},{text:'b',textStart:1,textEnd:2}];},async synthesize(unit){return {samples:new Float32Array([unit.text==='a'?1:2]),sampleRate:16000};},async unload(){}},()=>{throw new Error('Playback must remain lazy');});
      const generation=tts.generate('ab');
      check(typeof generation.audio['@@asyncIterator']==='function','Public TTS audio protocol missing');
      async function read(){const samples=[];for await(const chunk of generation.audio){samples.push(chunk.audio.samples[0]);}return samples.join(',');}
      const readers=await Promise.all([read(),read()]);
      check(readers[0]==='1,2' && readers[1]==='1,2','TTS iterable readers failed');
      let count=0;for await(const chunk of generation.audio){count++;break;}
      check(count===1,'TTS early return failed');
      generation.dispose();await tts.unload();
      print('HERMES_ASYNC_ITERATORS_OK');
    }
    main().catch(error=>{print('HERMES_FAILURE '+error.message+' '+error.stack);});
  `;
  const out=await build({stdin:{contents:entry,resolveDir:rn},bundle:true,write:false,format:'iife',platform:'node',plugins:[native]});
  const transformed=babel.transformSync(out.outputFiles[0].text,{filename:'hermes-regression.js',configFile:false,babelrc:false,presets:[[rnRequire.resolve('@react-native/babel-preset'),{unstable_transformProfile:'hermes-stable',enableBabelRuntime:false}]]}).code;
  const globals=`
    globalThis.console={error:function(){},warn:function(){},log:print};
    globalThis.performance={now:Date.now};
    globalThis.queueMicrotask=function(fn){Promise.resolve().then(fn);};
    globalThis.AbortController=function(){this.signal={aborted:false,listeners:[],addEventListener:function(type,fn){this.listeners.push(fn);},removeEventListener:function(type,fn){this.listeners=this.listeners.filter(function(item){return item!==fn;});}};};
    AbortController.prototype.abort=function(){if(this.signal.aborted)return;this.signal.aborted=true;this.signal.listeners.slice().forEach(function(fn){fn();});};
    globalThis.__wfloatTestTransport={uniqueId:function(){return 'model';},subscribe:function(){return function(){};},request:function(c,options){
      if(c.op==='load')return Promise.resolve({contextSize:128});
      if(c.op==='count')return Promise.resolve(1);
      if(c.op==='generateRound'){options.onEvent({type:'text',text:'Hermes works'});options.onEvent({type:'done',stopReason:'complete',inputTokens:1,outputTokens:2,cachedInputTokens:0});}
      return Promise.resolve(null);
    }};
  `;
  const hermes=resolve(root,'packages/react-native-wfloat/node_modules/react-native/sdks/hermesc/osx-bin/hermes');
  const run=spawnSync(hermes,['-'],{input:globals+'\n'+transformed,encoding:'utf8',timeout:15000,maxBuffer:2*1024*1024});
  assert.equal(run.error,undefined);assert.equal(run.status,0,run.stderr);
  assert.match(run.stdout,/HERMES_ASYNC_ITERATORS_OK/,run.stdout+'\n'+run.stderr);
});

test('native position events refill beyond lookahead and finish on final drain with JS intervals unavailable',async()=>{
  const original=globalThis.setInterval;
  globalThis.setInterval=()=>{throw new Error('Native playback must not depend on JS intervals');};
  calls.length=0;let position=0,syntheses=0;const events=[];
  respond=async command=>command.op==='playbackPosition'?position:null;
  const model=new TextToSpeechModel({sampleRate:16000,validate(){},
    async prepare(){return Array.from({length:24},(_,i)=>({text:'a',textStart:i,textEnd:i+1}));},
    async synthesize(){syntheses++;return {samples:new Float32Array(16000),sampleRate:16000};},async unload(){}});
  let speech;
  try{
    speech=model.speak('a'.repeat(24),{backgroundBehavior:'continue',onPlayback:event=>events.push(event)});
    await until(()=>syntheses===10&&calls.some(c=>c.op==='playbackPosition'));
    await turn();assert.equal(syntheses,10);
    const emit=[...listeners.values()][0];assert.equal(typeof emit,'function');
    for(const next of [5000,10000,15000]){
      position=next;emit({type:'playbackPosition',positionMs:position});
      await until(()=>syntheses===Math.min(24,next/1000+10));await turn();
    }
    assert.ok(speech.job.baseIndex>=15,'Played chunks should be released by native progress');
    assert.equal(syntheses,24);
    position=24000;emit({type:'playbackPosition',positionMs:position});
    await until(()=>events.some(e=>e.state==='finished'));
    assert.equal(events.filter(e=>e.state==='finished').length,1);
    assert.equal(calls.filter(c=>c.op==='playbackPosition').length,1,'Only initial clock reconciliation should request position');
    assert.equal(listeners.size,0,'Terminal speech detaches native events');
    emit({type:'playbackPosition',positionMs:position});await turn();
    assert.equal(events.filter(e=>e.state==='finished').length,1);
  }finally{speech?.cancel();await model.unload();globalThis.setInterval=original;}
});

test('native position events preserve monotonic clock, stop delivery while explicitly paused, and detach on close',async()=>{
  calls.length=0;let position=0;const seen=[];
  respond=async command=>command.op==='playbackPosition'?position:null;
  const driver=new NativePlayback();
  driver.onPosition(()=>seen.push(driver.positionMs()));
  const chunks=[{startMs:0,audio:{samples:new Float32Array(16000),sampleRate:16000},timeline:[]}];
  await driver.start(chunks,0);
  const emit=[...listeners.values()][0];
  try{
    emit({type:'playbackPosition',positionMs:400});await until(()=>seen.length===1);
    emit({type:'playbackPosition',positionMs:200});await until(()=>seen.length===2);
    assert.deepEqual(seen,[400,400]);
    driver.stop();position=500;emit({type:'playbackPosition',positionMs:500});await turn();
    assert.equal(seen.length,2);assert.equal(driver.positionMs(),500);
    await driver.start(chunks,500);
    emit({type:'playbackPosition',positionMs:1000});await until(()=>seen.length===3);
    assert.equal(seen[2],1000);
    await driver.dispose();emit({type:'playbackPosition',positionMs:1000});await turn();
    assert.equal(seen.length,3);
  }finally{await driver.dispose();}
});

const {VadOperation,configuration}=await import(await bundle(`export * from './vad-next/session';export * from './vad-next/segmenter';`));
for(const task of ['stt','vad']){
  function tailSession(factory,errors=[]){
    const received=[];
    const session=task==='stt'?new LiveSession({kind:'offline',async decode(samples){received.push(...samples);return {text:'tail'};}},{onError:error=>errors.push(error)},()=>{},factory):
      new VadOperation({sampleRate:16000,frameSize:512,async score(samples){received.push(...samples);return .9;}},configuration({minSpeechDurationMs:0,minSilenceDurationMs:0,speechPaddingMs:0,onError:error=>errors.push(error)}),false,()=>{},factory);
    if(task==='vad')session.begin();
    return {session,received};
  }
  test(task+' finish includes owned microphone stop-time PCM before flushing the resampler',async()=>{
    const stop=gate();let stops=0;
    const {session,received}=tailSession(async onAudio=>({async start(){},async stop(){stops++;await stop.promise;onAudio({samples:new Float32Array(768).fill(.25),sampleRate:48000});}}));
    await session.startMicrophone();const completion=session.finish();
    assert.equal(session.finish(),completion);
    await assert.rejects(session.startMicrophone(),/no longer accepts/);
    await assert.rejects(session.push({samples:new Float32Array([1]),sampleRate:16000}),/no longer accepts/);
    let settled=false;void completion.then(()=>{settled=true;});await turn();assert.equal(settled,false);
    stop.resolve();const result=await completion;await session.released;
    assert.equal(result.stopReason,'complete');assert.equal(stops,1);
    assert.equal(received.length,task==='stt'?256:512);
    assert.ok(received.slice(0,256).every(value=>Math.abs(value-.25)<1e-6));
    if(task==='vad'){assert.equal(result.segments[0].endMs,16);assert.ok(received.slice(256).every(value=>value===0));}
  });
  test(task+' cancellation during microphone stop discards late tail but waits for cleanup',async()=>{
    const stop=gate();
    const {session,received}=tailSession(async onAudio=>({async start(){},async stop(){await stop.promise;onAudio({samples:new Float32Array(512).fill(.5),sampleRate:16000});}}));
    await session.startMicrophone();session.finish();session.cancel();
    assert.equal((await session.result()).stopReason,'cancelled');
    let released=false;void session.released.then(()=>{released=true;});await turn();assert.equal(released,false);
    stop.resolve();await session.released;assert.equal(received.length,0);
  });
  test(task+' owned microphone stop failure rejects finish through the existing partial-result error path',async()=>{
    const error=Error('capture stop failed'),errors=[];
    const {session}=tailSession(async()=>({async start(){},async stop(){throw error;}}),errors);
    await session.startMicrophone();await assert.rejects(session.finish(),e=>e.cause===error&&e.partialResult!==undefined);
    await session.released;await turn();assert.equal(errors.length,1);
  });
}

for(const task of ['stt','vad'])test(task+' real owned capture adapter delivers native micStop tail before session finish',async()=>{
  calls.length=0;const received=[];
  respond=async command=>{
    if(command.op==='micStart')return {state:'recording'};
    if(command.op==='micStop')return [{sequence:1,samples:Array(768).fill(.375),sampleRate:48000}];
    if(command.op==='micAck')return null;
    throw Error('Unexpected command '+command.op);
  };
  const session=task==='stt'?new LiveSession({kind:'offline',async decode(samples){received.push(...samples);return {text:'native tail'};}},{},()=>{}):
    new VadOperation({sampleRate:16000,frameSize:512,async score(samples){received.push(...samples);return .9;}},configuration({minSpeechDurationMs:0,minSilenceDurationMs:0,speechPaddingMs:0}),false,()=>{});
  if(task==='vad')session.begin();
  await session.startMicrophone();
  const result=await session.finish();await session.released;
  assert.equal(result.stopReason,'complete');
  assert.equal(calls.filter(c=>c.op==='micStop').length,1);
  assert.ok(calls.some(c=>c.op==='micAck'&&c.sequence===1));
  assert.ok(received.slice(0,256).every(sample=>Math.abs(sample-.375)<1e-6));
  assert.equal(received.length,task==='stt'?256:512);
  if(task==='stt')assert.equal(result.text,'native tail');else assert.equal(result.segments[0].endMs,16);
  assert.equal(listeners.size,0);
});

test('background TTS underrun retains native queue and lease, then refills with append rather than start',async()=>{
  calls.length=0;let position=0,foreground=true,lease=false,syntheses=0;const events=[],second=gate();
  const interval=globalThis.setInterval;globalThis.setInterval=()=>{throw Error('No JS timers in background');};
  respond=async command=>{
    if(command.op==='playbackStart'){assert.equal(foreground,true,'Cannot reacquire background playback lease');lease=true;}
    if(command.op==='playbackPause'||command.op==='playbackClose')lease=false;
    if(command.op==='playbackAppend')assert.equal(lease,true,'Append must keep its audio-associated lease');
    return command.op==='playbackPosition'?position:null;
  };
  const model=new TextToSpeechModel({sampleRate:16000,validate(){},async prepare(){return [{text:'a',textStart:0,textEnd:1},{text:'b',textStart:1,textEnd:2}];},async synthesize(){if(++syntheses===2)await second.promise;return {samples:new Float32Array(16000),sampleRate:16000};},async unload(){}});
  let speech;
  try{
    speech=model.speak('ab',{backgroundBehavior:'continue',onPlayback:event=>events.push(event)});
    await until(()=>syntheses===2&&events.some(e=>e.state==='playing'));
    foreground=false;position=1000;const emit=[...listeners.values()][0];emit({type:'playbackPosition',positionMs:position});
    await until(()=>events.at(-1)?.state==='buffering');
    assert.equal(lease,true);assert.equal(calls.filter(c=>c.op==='playbackPause').length,0);
    second.resolve();await until(()=>calls.some(c=>c.op==='playbackAppend'));
    assert.equal(calls.filter(c=>c.op==='playbackStart').length,1);
    position=1250;emit({type:'playbackPosition',positionMs:position});await until(()=>events.at(-1)?.state==='playing');
    position=2000;emit({type:'playbackPosition',positionMs:position});await until(()=>events.at(-1)?.state==='finished');
    await until(()=>calls.some(c=>c.op==='playbackClose'));assert.equal(lease,false);
    assert.equal(events.filter(e=>e.state==='finished').length,1);
  }finally{second.resolve();speech?.cancel();await model.unload();globalThis.setInterval=interval;}
});

test('cancelling an underrun closes native playback and never appends late synthesis',async()=>{
  calls.length=0;let position=0,syntheses=0;const second=gate(),events=[];
  respond=async command=>command.op==='playbackPosition'?position:null;
  const model=new TextToSpeechModel({sampleRate:16000,validate(){},async prepare(){return [{text:'a',textStart:0,textEnd:1},{text:'b',textStart:1,textEnd:2}];},async synthesize(){if(++syntheses===2)await second.promise;return {samples:new Float32Array(16000),sampleRate:16000};},async unload(){}});
  const speech=model.speak('ab',{backgroundBehavior:'continue',onPlayback:event=>events.push(event)});
  try{
    await until(()=>syntheses===2&&events.some(e=>e.state==='playing'));
    position=1000;[...listeners.values()][0]({type:'playbackPosition',positionMs:position});
    await until(()=>events.at(-1)?.state==='buffering');speech.cancel();second.resolve();
    await until(()=>calls.some(c=>c.op==='playbackClose'));await turn();
    assert.equal(calls.filter(c=>c.op==='playbackStart').length,1);
    assert.equal(calls.filter(c=>c.op==='playbackAppend').length,0);
    assert.equal(events.at(-1).state,'cancelled');assert.equal(listeners.size,0);
  }finally{second.resolve();speech.cancel();await model.unload();}
});

test('continue playback preparation is deferred, listens before dispatch, and precedes direct synthesis/start',async()=>{
  calls.length=0;const prepared=gate();let handle,lease=false,syntheses=0;const observations=[];
  respond=async command=>{
    if(command.op==='playbackPrepare'){
      assert.ok(handle,'Preparation must dispatch after handle return');assert.equal(listeners.size,1);
      assert.deepEqual(Object.keys(command).sort(),['op','options','playbackId']);
      await prepared.promise;lease=true;return null;
    }
    if(command.op==='playbackStart'){assert.equal(lease,true);observations.push('start');}
    if(command.op==='playbackClose')lease=false;
    return command.op==='playbackPosition'?0:null;
  };
  const model=new TextToSpeechModel({sampleRate:16000,validate(){},async prepare(){assert.equal(lease,true);return [{text:'a',textStart:0,textEnd:1}];},async synthesize(){syntheses++;observations.push('synthesize');return {samples:new Float32Array(16000),sampleRate:16000};},async unload(){}});
  try{
    handle=model.speak('a',{backgroundBehavior:'continue'});
    assert.equal(calls.length,0);
    await until(()=>calls.some(c=>c.op==='playbackPrepare'));assert.equal(syntheses,0);
    assert.equal(calls.some(c=>c.op==='playbackStart'),false);
    prepared.resolve();await until(()=>observations.includes('start'));
    assert.deepEqual(observations,['synthesize','start']);
    assert.equal(calls.filter(c=>c.op==='playbackPrepare').length,1);
    handle.cancel();await model.unload();assert.equal(lease,false);
  }finally{prepared.resolve();handle?.cancel();await model.unload();}
});

test('cancelling continue speech before deferred prepare allocates no native lease',async()=>{
  calls.length=0;respond=async()=>{throw Error('Native allocation after immediate cancellation');};
  const model=new TextToSpeechModel({sampleRate:16000,validate(){},async prepare(){throw Error('Inference after immediate cancellation');},async synthesize(){throw Error('unused');},async unload(){}});
  const speech=model.speak('a',{backgroundBehavior:'continue'});speech.cancel();await model.unload();
  assert.equal(calls.length,0);assert.equal(listeners.size,0);
});

test('cancel during continue preparation closes its late lease without first PCM or audio focus',async()=>{
  calls.length=0;const gatePrepare=gate();let lease=false;
  respond=async command=>{
    if(command.op==='playbackPrepare'){await gatePrepare.promise;lease=true;}
    if(command.op==='playbackClose')lease=false;
    return null;
  };
  const driver=new NativePlayback({backgroundBehavior:'continue'});
  await until(()=>calls.some(c=>c.op==='playbackPrepare'));
  const closing=driver.dispose();let closed=false;void closing.then(()=>{closed=true;});await turn();assert.equal(closed,false);
  gatePrepare.resolve();await closing;
  assert.equal(lease,false);assert.deepEqual(calls.map(c=>c.op),['playbackPrepare','playbackClose']);assert.equal(listeners.size,0);
});

test('prepare failure closes partial allocation and prevents queued playbackStart',async()=>{
  calls.length=0;const error=Error('foreground service denied'),events=[];let lease=false;
  respond=async command=>{
    if(command.op==='playbackPrepare'){lease=true;throw error;}
    if(command.op==='playbackClose')lease=false;
    return null;
  };
  const driver=new NativePlayback({backgroundBehavior:'continue'},(state,cause)=>events.push({state,cause}));
  const starting=driver.start([{startMs:0,audio:{samples:new Float32Array(16000),sampleRate:16000},timeline:[]}],0);
  await assert.rejects(starting,e=>e===error);await driver.dispose();
  assert.deepEqual(calls.map(c=>c.op),['playbackPrepare','playbackClose']);assert.equal(lease,false);
  assert.deepEqual(events,[{state:'failed',cause:error}]);assert.equal(listeners.size,0);
});

test('service failure before first PCM fails once and closes prepared-only playback',async()=>{
  calls.length=0;const events=[];
  respond=async()=>null;
  const driver=new NativePlayback({backgroundBehavior:'continue'},(state,error)=>events.push({state,error}));
  await driver.ready;const emit=[...listeners.values()][0];
  emit({type:'playbackState',state:'failed',message:'service stopped'});await driver.dispose();
  emit({type:'playbackState',state:'failed',message:'duplicate'});
  assert.deepEqual(calls.map(c=>c.op),['playbackPrepare','playbackClose']);assert.equal(events.length,1);
  assert.equal(events[0].error.message,'service stopped');assert.equal(listeners.size,0);
});

test('explicit pause after OS suspension sends native pause and rejects stale auto-resume until user resume',async()=>{
  calls.length=0;const events=[];
  respond=async c=>c.op==='playbackPosition'?0:null;
  const model=new TextToSpeechModel({sampleRate:16000,validate(){},async prepare(){return [{text:'x',textStart:0,textEnd:1}];},async synthesize(){return {samples:new Float32Array(16000),sampleRate:16000};},async unload(){}});
  const speech=model.speak('x',{backgroundBehavior:'pauseAndAutoResume',onPlayback:e=>events.push(e.state)});
  try{
    await until(()=>events.includes('playing'));const emit=[...listeners.values()][0];
    emit({type:'playbackState',state:'paused'});await until(()=>events.at(-1)==='paused');
    assert.equal(calls.filter(c=>c.op==='playbackPause').length,0);
    speech.pause();emit({type:'playbackState',state:'resumed'});
    await until(()=>calls.some(c=>c.op==='playbackPause'));await turn();
    assert.equal(calls.filter(c=>c.op==='playbackStart').length,1);
    assert.equal(events.filter(e=>e==='paused').length,1);assert.equal(events.at(-1),'paused');
    speech.resume();await until(()=>calls.filter(c=>c.op==='playbackStart').length===2);
    await until(()=>events.at(-1)==='playing');
  }finally{speech.cancel();await model.unload();}
});

test('model rejects stale injected native resume after explicit pause while OS-suspended',async()=>{
  const f=pausedFixture(false);
  try{
    await until(()=>f.syntheses===2);f.onState('paused');f.speech.pause();assert.equal(f.stops,1);
    f.onState('resumed');f.blocked.resolve();await turn();await turn();assert.equal(f.syntheses,2);
    f.speech.resume();await until(()=>f.syntheses===3);
  }finally{f.blocked.resolve();f.speech.cancel();await f.model.unload();}
});

for(const inFlight of [false,true])test('prepared-only pause renews readiness before synthesis'+(inFlight?' even with old prepare in flight':''),async()=>{
  calls.length=0;const first=gate(),second=gate();let preparations=0,lease=false,created=false,syntheses=0;const events=[];
  respond=async c=>{
    if(c.op==='playbackPrepare'){assert.equal(created,false);await (++preparations===1?first:second).promise;lease=true;}
    if(c.op==='playbackPause'){assert.equal(lease,true);lease=false;[...listeners.values()][0]?.({type:'playbackState',state:'paused'});}
    if(c.op==='playbackStart'){assert.equal(lease,true);created=true;}
    if(c.op==='playbackPosition'){assert.equal(created,true,'Prepared-only position is undefined');return 0;}
    if(c.op==='playbackClose')lease=false;
    return null;
  };
  // Hold generation preparation so the settled-lease case also remains PCM-free.
  const units=gate();
  const model=new TextToSpeechModel({sampleRate:16000,validate(){},async prepare(){await units.promise;return [{text:'x',textStart:0,textEnd:1}];},async synthesize(){assert.equal(lease,true);syntheses++;return {samples:new Float32Array(16000),sampleRate:16000};},async unload(){}});
  const speech=model.speak('x',{backgroundBehavior:'continue',onPlayback:e=>events.push(e.state)});
  try{
    await until(()=>preparations===1);
    if(!inFlight){first.resolve();await until(()=>lease);await turn();}
    speech.pause();speech.pause();speech.resume();first.resolve();
    await until(()=>preparations===2);units.resolve();await turn();await turn();
    assert.equal(syntheses,0);assert.equal(lease,false);assert.equal(calls.some(c=>c.op==='playbackPosition'),false);
    assert.deepEqual(calls.map(c=>c.op),['playbackPrepare','playbackPause','playbackPrepare']);
    second.resolve();await until(()=>events.includes('playing'));assert.equal(syntheses,1);
    assert.equal(new Set(calls.filter(c=>c.op==='playbackPrepare').map(c=>c.playbackId)).size,1);
  }finally{first.resolve();second.resolve();units.resolve();speech.cancel();await model.unload();}
  assert.equal(lease,false);assert.equal(listeners.size,0);
});

test('failed reprepare cleans up prepared-only playback without synthesis or start',async()=>{
  calls.length=0;const first=gate(),events=[];let prepares=0,syntheses=0;
  respond=async c=>{
    if(c.op==='playbackPrepare'){if(++prepares===1)await first.promise;else throw Error('resume lease denied');}
    return null;
  };
  const model=new TextToSpeechModel({sampleRate:16000,validate(){},async prepare(){syntheses++;return [];},async synthesize(){throw Error('unexpected synthesis');},async unload(){}});
  const speech=model.speak('x',{backgroundBehavior:'continue',onPlayback:e=>events.push(e.state)});
  try{
    await until(()=>prepares===1);speech.pause();speech.resume();first.resolve();
    await until(()=>events.includes('failed'));await model.unload();
    assert.equal(syntheses,0);assert.deepEqual(calls.map(c=>c.op),['playbackPrepare','playbackPause','playbackPrepare','playbackClose']);assert.equal(listeners.size,0);
  }finally{first.resolve();speech.cancel();await model.unload();}
});

for(const osPause of [false,true])test((osPause?'OS interruption':'Explicit pause')+' during an underrun renews the existing-player lease before further synthesis',async()=>{
  calls.length=0;const pendingSynthesis=gate(),reprepared=gate();let prepares=0,syntheses=0,position=0,lease=false,foreground=true;const events=[];
  respond=async c=>{
    if(c.op==='playbackPrepare'){assert.equal(foreground,true);if(++prepares===2)await reprepared.promise;lease=true;}
    if(c.op==='playbackStart')assert.equal(lease,true,'Background resume requires its prepared lease');
    if(c.op==='playbackPause'||c.op==='playbackClose')lease=false;
    return c.op==='playbackPosition'?position:null;
  };
  const model=new TextToSpeechModel({sampleRate:16000,validate(){},async prepare(){return ['a','b','c'].map((text,i)=>({text,textStart:i,textEnd:i+1}));},async synthesize(){assert.equal(lease,true,'Synthesis must await resumed lease');if(++syntheses===2)await pendingSynthesis.promise;return {samples:new Float32Array(16000),sampleRate:16000};},async unload(){}});
  const speech=model.speak('abc',{backgroundBehavior:'continue',onPlayback:e=>events.push(e.state)});
  try{
    await until(()=>syntheses===2&&events.includes('playing'));position=1000;
    [...listeners.values()][0]({type:'playbackPosition',positionMs:1000});await until(()=>events.at(-1)==='buffering');
    if(osPause){lease=false;[...listeners.values()][0]({type:'playbackState',state:'paused'});await until(()=>events.at(-1)==='paused');}
    else {speech.pause();await until(()=>!lease);}
    speech.resume();await until(()=>prepares===2);
    pendingSynthesis.resolve();await turn();await turn();assert.equal(syntheses,2);
    assert.equal(calls.filter(c=>c.op==='playbackStart').length,1);
    foreground=false;reprepared.resolve();await until(()=>syntheses===3&&calls.filter(c=>c.op==='playbackStart').length===2);
    assert.equal(lease,true);assert.equal(calls.filter(c=>c.op==='playbackPrepare').length,2);
  }finally{pendingSynthesis.resolve();reprepared.resolve();speech.cancel();await model.unload();}
  assert.equal(lease,false);
});
