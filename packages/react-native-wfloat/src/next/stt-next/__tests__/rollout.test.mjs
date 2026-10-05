import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(new URL('../../../../../wfloat-web/package.json',import.meta.url));
const {build}=require('esbuild');
const fixtures={name:'rn-stt-fixtures',setup(b){
  b.onResolve({filter:/assets\/index$/},()=>({path:'assets',namespace:'fixture'}));
  b.onResolve({filter:/llm-native\/instance$/},()=>({path:'native',namespace:'fixture'}));
  b.onResolve({filter:/platform\/bridge$/},()=>({path:'bridge',namespace:'fixture'}));
  b.onResolve({filter:/\/microphone$/},()=>({path:'mic',namespace:'fixture'}));
  b.onLoad({filter:/.*/,namespace:'fixture'},({path})=>({contents:({
    assets:`export async function loadAssets(id,task){const f=globalThis.__rnStt;f.assetCalls.push([id,task]);return {family:f.family,paths:f.paths,signal:f.signal,assertCurrent(){f.checked++},release(){f.released++}}}`,
    native:`export class NativeInstance {async call(op,args){const f=globalThis.__rnStt;f.calls.push([op,args]);if(f.fail===op)throw Error('native failure');if(op==='load')return {kind:f.kind};if(op==='transcribe')return {text:f.texts.shift()??'你好'};if(op==='pushStream')return {text:f.texts.shift()??'世界',isEndpoint:true};}async unload(){globalThis.__rnStt.unloaded++;}}`,
    bridge:`export const request=()=>{throw Error('Unexpected platform call');};export function checkAbort(s){if(s?.aborted)throw s.reason;}export const abortError=()=>Error('aborted');export const notify=(fn,e)=>fn?.(e);`,
    mic:`export const startMicrophone=()=>{throw Error('No device capture in contracts');};export const attachCapture=startMicrophone;`,
  })[path]}));
}};
async function load(name){const r=await build({entryPoints:[new URL('../'+name+'.ts',import.meta.url).pathname],bundle:true,write:false,platform:'node',format:'esm',plugins:[fixtures]});return import('data:text/javascript;base64,'+Buffer.from(r.outputFiles[0].text+'\n//# sourceURL=rn-stt-'+name+'.mjs').toString('base64'));}
const {joinText,overlapText}=await load('transcript');
const {sttCapabilities,validateRecognitionOptions}=await load('capabilities');
const {loadSpeechToText,loadStreamingSpeechToText}=await load('load');
const models=['openai/whisper-tiny','openai/whisper-base','openai/whisper-small','moonshine-ai/moonshine-base','shaojieli/streaming-zipformer-fr','k2-fsa/streaming-zipformer-zh-en'];
function fixture(id){const c=sttCapabilities(id);return globalThis.__rnStt={family:c.family,kind:c.kind,signal:new AbortController().signal,paths:id==='moonshine-ai/moonshine-base'?{tokens:'/tokens.txt',encoder:'/encoder.ort',merged_decoder:'/decoder.ort'}:{tokens:'/tokens',encoder:'/encoder',decoder:'/decoder',joiner:'/joiner'},assetCalls:[],calls:[],checked:0,released:0,unloaded:0,texts:[]};}
const pcm=n=>({samples:new Float32Array(n).fill(.1),sampleRate:16000});
test('script-aware joins preserve CJK, combining marks, punctuation and Latin spaces',()=>{
  for(const [a,b,result] of [['你好','世界','你好世界'],['你好。','世界','你好。世界'],['今日は','東京','今日は東京'],['สวัสดี','ครับ','สวัสดีครับ'],['bonjour','le monde','bonjour le monde'],['hello','，世界','hello，世界']])assert.equal(joinText(a,b),result);
});
test('overlap uses actual reference, preserves original prefix and punctuation, and bounds repeated phrases',()=>{
  for(const [a,b,reference,result] of [
    ['今天你好世界','你好世界再见','你好世界','今天你好世界再见'],
    ['今天你好世界。','你好世界，再见','你好世界','今天你好世界，再见'],
    ['今日は東京','東京です','東京','今日は東京です'],
    ['你好 OpenAI','OpenAI 世界','OpenAI','你好 OpenAI 世界'],
    ['bonjour  le monde','le monde entier','le monde','bonjour  le monde entier'],
    ['旧文本','新文本','不匹配','旧文本新文本'],
    ['你好你好','你好世界','你好','你好你好世界'],
    ['one two one two','one two three','one two','one two one two three'],
    ['keep this','different words','','keep this different words'],
  ])assert.equal(overlapText(a,b,reference).text,result);
});
for(const id of models)test(id+' file/live loaders preserve paths, dispatch and cleanup',async()=>{
  const f=fixture(id),progress=[];
  const model=await loadSpeechToText(id,{onProgress:e=>progress.push(e.phase)});
  assert.deepEqual(f.assetCalls,[[id,'stt']]);assert.equal(f.checked,1);assert.ok(f.released);
  assert.deepEqual(f.calls[0],['load',{task:'stt',modelId:id,family:f.family,paths:f.paths,options:{}}]);
  assert.deepEqual(progress,['loading','ready']);
  f.texts=['你好','世界'];
  const result=await model.transcribe(pcm(f.kind==='offline'?26*16000:10240)).result();
  assert.equal(result.text,'你好世界');assert.equal(result.stopReason,'complete');
  if(f.kind==='online')assert.ok(f.calls.some(([op])=>op==='closeStream'));
  await model.unload();assert.equal(f.unloaded,1);
  const live=fixture(id),streaming=await loadStreamingSpeechToText(id);
  const session=await streaming.createSession();await session.push(pcm(1600));const finished=await session.finish();
  assert.equal(finished.stopReason,'complete');assert.ok(finished.text);await streaming.unload();assert.equal(live.unloaded,1);
});
test('six-model load failures release leases and native resources without reporting ready',async()=>{
  for(const id of models)for(const failure of ['family','kind','load','abort']){
    const f=fixture(id),progress=[];
    if(failure==='family')f.family='wrong';if(failure==='kind')f.kind=f.kind==='online'?'offline':'online';if(failure==='load')f.fail='load';
    if(failure==='abort'){const c=new AbortController();c.abort(Error('cancelled'));f.signal=c.signal;}
    await assert.rejects(loadSpeechToText(id,{onProgress:e=>progress.push(e.phase)}));assert.equal(f.unloaded,1);assert.ok(f.released);assert.ok(!progress.includes('ready'));
    if(failure==='family')assert.equal(f.calls.length,0);
  }
});
test('six-model capability policies and existing Parakeet/Moonshine Tiny remain intact',()=>{
  for(const id of models){
    const c=sttCapabilities(id);validateRecognitionOptions(id,{});
    assert.throws(()=>validateRecognitionOptions(id,{hotwords:[]}));assert.throws(()=>validateRecognitionOptions(id,{timestamps:'word'}));
    if(c.family==='whisper'){
      for(const language of ['fr-CA','ZH_hans_CN','haw','jw'])validateRecognitionOptions(id,{language,task:'translate',timestamps:'segment'});
      for(const language of ['auto','','xx','yue','en:foo'])assert.throws(()=>validateRecognitionOptions(id,{language}));
    }else{
      assert.throws(()=>validateRecognitionOptions(id,{task:'translate'}));assert.throws(()=>validateRecognitionOptions(id,{timestamps:'segment'}));
      const languages=id.includes('-zh-en')?['zh-CN','en-US']:c.family==='moonshine'?['en']:['fr-FR'];
      for(const language of languages)validateRecognitionOptions(id,{language});assert.throws(()=>validateRecognitionOptions(id,{language:'de'}));
    }
  }
  assert.throws(()=>validateRecognitionOptions('nvidia/parakeet-tdt-0.6b-v3',{language:'en'}),/automatically/);
  assert.equal(sttCapabilities('UsefulSensors/moonshine-tiny').kind,'offline');
});
test('windowed live CJK reconciles only the separately decoded three-second overlap',async()=>{
  const f=fixture('openai/whisper-small');f.texts=['今天你好世界。','你好世界','你好世界，再见'];
  const model=await loadStreamingSpeechToText('openai/whisper-small');const session=await model.createSession({maxBufferedAudioMs:60000});
  await session.push(pcm(28*16000));const result=await session.finish();
  assert.equal(result.text,'今天你好世界，再见');
  assert.deepEqual(f.calls.filter(([op])=>op==='transcribe').map(([,j])=>j.samples.length),[25*16000,3*16000,6*16000]);
  await model.unload();
});
test('combining marks remain significant in overlap and blank boundaries add no spaces',()=>{
  assert.equal(overlapText('ดี','ดู','ดี').droppedWords,0);
  assert.equal(joinText('   ','hello'),'hello');assert.equal(joinText('hello','   '),'hello');
});
