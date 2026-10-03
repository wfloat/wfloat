// Real stored-assets loader + dedicated sherpa worker + Web Audio integration.
// Run from package root: node tests/tts-next/browser.mjs /path/to/playwright/index.mjs
// Add --playback-only for real Web Audio lifecycle/failure tests without model downloads.
import { runDefaultAutoplayScenario } from './browser-autoplay.mjs';
import { runPlaybackScenarios } from './browser-playback.mjs';
import { createServer } from 'node:http';
import { readFile, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from '../../node_modules/esbuild/lib/main.js';
const { chromium } = await import(pathToFileURL(resolve(process.argv[2])));
const dir = await mkdtemp(join(tmpdir(), 'wfloat-tts-next-'));
const bundle = async entry => (await build({ entryPoints:[entry], bundle:true, write:false, format:'esm', platform:'browser' })).outputFiles[0].text;
const [loader,worker,playback,model,cacheFixture] = await Promise.all([bundle('src/tts-next/load.ts'),bundle('src/tts-next/worker.ts'),bundle('src/tts-next/playback.ts'),bundle('src/tts-next/model.ts'),bundle('tests/tts-next/cache-fixture.ts')]);
let wasmRequests=0;let cacheProbeRequests=0;
const server=createServer(async(req,res)=>{try{
 const path=new URL(req.url,'http://localhost').pathname;
 if(path==='/'){res.setHeader('Content-Type','text/html');res.end('<!doctype html><title>TTS next integration</title>');return;}
 if(path==='/cache-probe.bin'){cacheProbeRequests++;res.setHeader('Content-Type','application/octet-stream');res.end(Buffer.from([1,2,3,4]));return;}
 if(path.endsWith('.wasm')){wasmRequests++;res.setHeader('Content-Type','application/wasm');res.end(await readFile('src/wasm/sherpa-onnx-wasm-main-speech.wasm'));return;}
 const content={'/tts-next/load.js':loader,'/tts-next/tts-worker.js':worker,'/tts-next/playback.js':playback,'/tts-next/model.js':model,'/tts-next/cache-fixture.js':cacheFixture}[path];
 if(!content){res.writeHead(404).end();return;}res.setHeader('Content-Type','text/javascript');res.end(content);
}catch(error){res.writeHead(500).end(String(error));}});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true,args:['--autoplay-policy=no-user-gesture-required','--mute-audio']});
try{
 const context=await browser.newContext();const page=await context.newPage();
 const pageErrors=[];page.on('pageerror',e=>{pageErrors.push(e);console.error('PAGE',e);});page.on('console',m=>{if(m.type()==='error'||m.text().startsWith('TTS'))console.log(m.type(),m.text());});
 await page.goto(`http://127.0.0.1:${server.address().port}`);
 const report=process.argv.includes('--playback-only') ? {} : await page.evaluate(async()=>{
  const assert=(v,m)=>{if(!v)throw Error(m);};const sleep=ms=>new Promise(r=>setTimeout(r,ms));
  const {loadTextToSpeech}=await import('/tts-next/load.js');const progress=[];
  console.log('TTS loading');
  const model=await loadTextToSpeech('wfloat/wfloat-tts',{persistence:'off',onProgress:e=>{progress.push(e);if(e.phase!=='downloading')console.log('TTS phase',e.phase);}});
  assert(progress.at(-1).phase==='ready','No ready phase');
  const texts=['Hello. Another sentence!', '  Hello there.\n\tNext sentence.  ', 'Hi 👋! Café costs $3.50. Dr. Smith agrees…'];
  const recordings=[];
  for(const text of texts){
   console.log('TTS synthesizing',JSON.stringify(text));
   const g=model.generate(text);const r=await g.result();assert(r.audio.samples.length>0,'No samples');
   assert(r.audio.samples.some(x=>Math.abs(x)>0.0001),'Silent output');
   for(const t of r.timeline)assert(t.text===text.slice(t.textStart,t.textEnd),'Incorrect original offsets');
   assert(r.timeline.map(t=>t.text).join('')===text,'Lost original text');
   recordings.push({text,samples:r.audio.samples.length,sampleRate:r.audio.sampleRate,timeline:r.timeline});g.dispose();
  }
  const g=model.generateDialogue([{text:'One.',pauseAfterMs:150},{text:'Two.',pauseAfterMs:100}],{pauseBetweenSegmentsMs:999});
  const r=await g.result();const events=[];let speech;let paused=false;
  const done=new Promise((resolve,reject)=>{
   const timeout=setTimeout(()=>reject(Error('Playback timeout')),20000);
   speech=g.speak({onPlayback:e=>{
    events.push({state:e.state,highlight:e.highlight});
    if(e.state==='failed'){clearTimeout(timeout);reject(e.error);}
    if(e.state==='playing'&&!paused){paused=true;speech.pause();setTimeout(()=>speech.resume(),80);}
    if(e.state==='finished'){clearTimeout(timeout);resolve();}
   }});
  });await done;
  assert(events.some(e=>e.state==='paused'),'Missing paused');assert(events.some(e=>e.state==='playing'&&e.highlight===null),'Missing silence playback');
  assert(events.filter(e=>e.state==='finished').length===1,'Duplicate finished');g.dispose();
  const {WebAudioPlayback}=await import('/tts-next/playback.js');
  const starts=[];const native=AudioBufferSourceNode.prototype.start;
  AudioBufferSourceNode.prototype.start=function(when,offset,...args){starts.push({when,offset,duration:this.buffer.duration});return native.call(this,when,offset,...args);};
  const player=new WebAudioPlayback();
  const chunk=startMs=>({audio:{samples:new Float32Array(4800).fill(0.01),sampleRate:48000},startMs,timeline:[]});
  await player.start([chunk(0),chunk(100),chunk(200)],0);
  const blockUntil=performance.now()+180;while(performance.now()<blockUntil){}
  assert(starts.length===3,'Sources were not scheduled ahead');
  assert(Math.abs(starts[1].when-starts[0].when-0.1)<1e-6 && Math.abs(starts[2].when-starts[1].when-0.1)<1e-6,'Audio clock gaps');
  assert(player.positionMs()>100,'Audio clock did not advance while main thread blocked');
  player.stop();const stopped=player.positionMs();await sleep(40);assert(player.positionMs()===stopped,'Pause position moved');player.close();AudioBufferSourceNode.prototype.start=native;
  const pendingAbort=new AbortController();let aborted=false;
  try{await loadTextToSpeech('wfloat/wfloat-tts',{persistence:'off',signal:pendingAbort.signal,onProgress:e=>{if(e.phase==='loading')pendingAbort.abort();}});}catch(e){aborted=e.name==='AbortError';}
  assert(aborted,'Loading abort did not reject with AbortError');
  const cached=[];const readyAbort=new AbortController();
  const other=await loadTextToSpeech('wfloat/wfloat-tts',{persistence:'off',signal:readyAbort.signal,onProgress:e=>{cached.push(e);if(e.phase==='ready')readyAbort.abort();}});
  assert(!cached.some(e=>e.phase==='downloading'),'Cached load downloaded again');
  const independent=await Promise.all([model.generate('First instance.').result(),other.generate('Second instance.').result()]);
  assert(independent.every(r=>r.audio.samples.length>0),'Instance isolation failed');
  await model.unload();await model.unload();await other.unload();
  return {phases:[...new Set(progress.map(e=>e.phase))],recordings,dialogue:r.timeline,events,starts,cached};
 });
 report.playbackScenarios=await page.evaluate(runPlaybackScenarios);
 const probe=()=>page.evaluate(async()=>await (await import('/tts-next/cache-fixture.js')).probe());
 const cacheChecks=[await probe()];
 await page.reload();cacheChecks.push(await probe());
 const secondTab=await context.newPage();await secondTab.goto(page.url());
 cacheChecks.push(await secondTab.evaluate(async()=>await (await import('/tts-next/cache-fixture.js')).probe()));
 await secondTab.close();
 if(cacheProbeRequests!==1||cacheChecks.some(r=>r.persistenceRequests!==0||r.bytes.join(',')!=='1,2,3,4'))throw Error('IndexedDB cache/persistence-off regression');
 report.cacheScope={requests:cacheProbeRequests,checks:cacheChecks,scope:'same origin and browser context, across reload and second tab'};
 if(pageErrors.length)throw new AggregateError(pageErrors,'Unhandled browser errors');
 if(!process.argv.includes('--playback-only') && wasmRequests!==1)throw Error(`Runtime bypassed cache: ${wasmRequests} WASM requests`);
 report.defaultAutoplay=await runDefaultAutoplayScenario(chromium,page.url());
 const path=join(dir,'report.json');await writeFile(path,JSON.stringify(report,null,2));console.log('PASS',path);
}finally{await browser.close();server.close();}
