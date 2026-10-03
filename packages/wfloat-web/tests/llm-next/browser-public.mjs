// Real public web SDK + durable storage + dedicated WASM worker integration.
// node tests/llm-next/browser-public.mjs MODEL_GGUF PLAYWRIGHT_MODULE
import { createServer } from 'node:http';
import { readFile, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
const [modelPath, playwrightPath] = process.argv.slice(2);
const {chromium} = await import(pathToFileURL(resolve(playwrightPath)));
const dir=await mkdtemp(join(tmpdir(),'wfloat-public-browser-'));
await build({entryPoints:['src/llm-next/load.ts'],outfile:join(dir,'load.js'),bundle:true,format:'esm',plugins:[{name:'local-registry',setup(b){b.onLoad({filter:/generatedModelUrls\.ts$/},async args=>({contents:(await readFile(args.path,'utf8')).replace('\"https://registry.wfloat.com\"','globalThis.location.origin'),loader:'ts'}));}}]});
await build({entryPoints:['src/llm-native/worker.ts'],outfile:join(dir,'llm-native-worker.js'),bundle:true,format:'esm'});
await build({stdin:{contents:`export {downloadModel,deleteModelAssets} from './src/assets/index.ts';`,resolveDir:process.cwd()},outfile:join(dir,'assets.js'),bundle:true,format:'esm'});
let modelRequests=0;
const modelBytes=await readFile(modelPath);
const server=createServer(async(req,res)=>{try{
 const url=new URL(req.url,'http://localhost');
 let path;
 if(url.pathname==='/model.gguf' || url.pathname.startsWith('/models/')){modelRequests++;res.setHeader('Content-Length',modelBytes.length);res.end(modelBytes);return;}
 if(url.pathname.endsWith('.wasm')) path=resolve('src/wasm/wfloat-llama-wasm.wasm');
 else if(url.pathname==='/') {res.setHeader('Content-Type','text/html');res.end('<!doctype html><title>Wfloat public integration</title>');return;}
 else path=join(dir,url.pathname.slice(1));
 res.setHeader('Content-Type',path.endsWith('.js')?'text/javascript':'application/wasm');res.end(await readFile(path));
}catch{res.writeHead(404).end();}});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const origin=`http://127.0.0.1:${server.address().port}`;
const browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
try {
 const context=await browser.newContext();
 const page=await context.newPage();page.on('pageerror',error=>console.error('PAGE',error));page.on('console',m=>console.log(m.type(),m.text()));page.on('crash',()=>console.error('BROWSER PAGE CRASH'));
 await page.goto(origin);
 const report=await page.evaluate(async()=>{
  const {loadLanguageModel}=await import('/load.js');
  const assert=(value,message)=>{if(!value)throw Error(message);};
  const events=[];
  console.log('Public load beginning');
  const model=await loadLanguageModel('HuggingFaceTB/SmolLM2-360M-Instruct',{contextSize:512,persistence:'off',onProgress:e=>events.push(e)});
  assert(events[0].phase==='checking','Missing checking');assert(events.at(-1).phase==='ready','Missing ready');
  console.log('Public load ready');
  const messages=[{role:'user',content:'Say hello.'}];
  const count=await model.countInputTokens(messages);
  let handle;const fragments=[];
  handle=model.generate(messages,{temperature:0,maxTokensPerRound:8,onText:t=>{assert(handle,'Callback before handle');fragments.push(t);}});
  const result=await handle.result();await handle.finished;
  assert(result.text===fragments.join(''),'Streaming differs from result');assert(result.usage.inputTokens===count,'Token count mismatch');assert(result.usage.outputTokens>0,'Missing output usage');
  const schema={type:'object',properties:{answer:{const:'yes'}},required:['answer'],additionalProperties:false};
  const structured=await model.generate([{role:'user',content:'Return yes in JSON.'}],{temperature:0,maxTokensPerRound:40,structuredOutput:{schema}}).result();
  assert(structured.output?.answer==='yes','Invalid public structured output');
  const cancelled=model.generate([{role:'user',content:'Count from one to one hundred.'}],{onText(){cancelled.cancel();}});
  const stopped=await cancelled.result();assert(stopped.stopReason==='cancelled','Public cancellation failed');
  console.log('Public first operation tests passed');
  const secondEvents=[];
  const other=await loadLanguageModel('HuggingFaceTB/SmolLM2-360M-Instruct',{contextSize:512,persistence:'off',onProgress:e=>secondEvents.push(e)});
  assert(!secondEvents.some(e=>e.phase==='downloading'),'Cached model spuriously downloads');
  const parallel=await Promise.all([model.generate(messages,{maxTokensPerRound:2}).result(),other.generate(messages,{maxTokensPerRound:2}).result()]);
  assert(parallel.every(r=>r.usage.outputTokens>0),'Independent instances failed');
  // Consumer experiments: boundaries, queue recovery, and interruption on real WASM.
  const prompt=[{role:'user',content:'Count from one to ten, writing the numbers in words.'}];
  const baseline=await model.generate(prompt,{temperature:0,maxTokensPerRound:24}).result();
  assert(baseline.text.length>=4,'Too little text for stop-string experiment');
  const marker=baseline.text.slice(1,4),stopFragments=[];
  const markerResult=await model.generate(prompt,{temperature:0,maxTokensPerRound:24,stopStrings:[marker],onText:t=>stopFragments.push(t)}).result();
  assert(markerResult.stopReason==='stopString','Real stop string did not stop');
  assert(markerResult.text===baseline.text.slice(0,baseline.text.indexOf(marker)),'Real stop leaked marker/trailing text');
  assert(markerResult.text===stopFragments.join(''),'Real stop stream/result mismatch');
  const overflow=await model.generate([{role:'user',content:'hello '.repeat(700)}]).result();
  assert(overflow.stopReason==='contextLimit'&&overflow.contextLimit?.phase==='input','Missing input-overflow result');
  assert(overflow.usage.outputTokens===0,'Overflow should not sample');
  let badSchema;
  try { await model.generate(messages,{structuredOutput:{schema:{type:'string',unsupportedKeyword:true}}}).result(); }
  catch(error){badSchema=error;}
  assert(badSchema?.name==='GenerationError','Unsupported schema should fail operation');
  const countJobs=[];
  const counted=model.generate(prompt,{temperature:0,maxTokensPerRound:8,onText(){countJobs.push(model.countInputTokens(messages));}});
  const countResult=await counted.result();
  assert(countResult.text.length>0,'No recovery after overflow/schema errors');
  assert((await Promise.all(countJobs)).every(n=>n===count),'Count changed during active generation');
  const order=[];
  const original=[{role:'user',content:'Say hello.'}];
  const first=model.generate(messages,{temperature:0,maxTokensPerRound:3,onRoundStart(){order.push('first');}});
  const queued=model.generate(original,{temperature:0,maxTokensPerRound:3,onRoundStart(){order.push('queued');}});
  original[0].content='hello '.repeat(700);
  const skipped=model.generate(messages,{onRoundStart(){order.push('cancelled');}});
  skipped.cancel();
  assert((await skipped.result()).stopReason==='cancelled','Queued cancel failed');
  await first.result();const queuedResult=await queued.result();
  assert(queuedResult.stopReason!=='contextLimit','Queued input was not snapshotted');
  assert(order.join(',')==='first,queued','FIFO/queued cancellation wrong');
  let unloading,active;
  active=model.generate(prompt,{onText(){unloading??=model.unload();}});
  const behind=model.generate(messages);
  assert((await active.result()).stopReason==='cancelled','Unload did not cancel active generation');
  assert((await behind.result()).stopReason==='cancelled','Unload did not cancel queue');
  await unloading;await model.unload();
  let closed=false;try{model.generate(messages);}catch{closed=true;}
  assert(closed,'Unloaded model accepted generation');
  const survivor=await other.generate(messages,{maxTokensPerRound:2}).result();
  assert(survivor.usage.outputTokens>0,'Unloading one instance affected another');
  await other.unload();
  console.log('PASS extended real LLM interactions',JSON.stringify({stop:markerResult.stopReason,overflow:overflow.stopReason,concurrentCounts:countJobs.length,order}));
  return {events,result,structured,stopped,secondEvents,parallel};
 });
 if(modelRequests!==1)throw Error(`Expected one model network request, saw ${modelRequests}`);
 await writeFile(join(dir,'report.json'),JSON.stringify(report,null,2));console.log(`PASS public SDK browser integration: ${dir}/report.json`);
} finally {await browser.close();server.close();}
