// Real public loader + asset storage + dedicated sherpa WASM + browser audio decoding.
// node tests/vad-next/browser.mjs /absolute/path/to/playwright/index.mjs /absolute/path/to/speech.wav
// Optional --serve keeps the test page available for Safari/manual browser verification.
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from '../../node_modules/esbuild/lib/main.js';
const serve = process.argv.includes('--serve');
const wasmHash = createHash('sha256').update(await readFile('src/wasm/sherpa-onnx-wasm-main-speech.wasm')).digest('hex');
const bundle = async path => (await build({entryPoints:[path],bundle:true,write:false,format:'esm',platform:'browser'})).outputFiles[0].text.replaceAll("../wasm/sherpa-onnx-wasm-main-speech.wasm", "../wasm/sherpa-onnx-wasm-main-speech.wasm?sha256="+wasmHash);
const files = new Map(await Promise.all([
 ['/vad-next/load.js','src/vad-next/load.ts'],['/vad-next/vad-worker.js','src/vad-next/worker.ts'],['/vad-next/stt-worker.js','src/stt-next/worker.ts'],
].map(async([url,path])=>[url,await bundle(path)])));
files.set('/vad-next/load.js', (await build({stdin:{contents:"export {loadVoiceActivityDetection} from './src/vad-next/load.ts'; export {loadStreamingSpeechToText} from './src/stt-next/load.ts'; export {createMicrophoneCapture} from './src/audio-next/microphone.ts';",resolveDir:process.cwd()},bundle:true,write:false,format:'esm',platform:'browser'})).outputFiles[0].text.replaceAll('../wasm/sherpa-onnx-wasm-main-speech.wasm','../wasm/sherpa-onnx-wasm-main-speech.wasm?sha256='+wasmHash));
const client = await readFile(new URL('./browser-client.mjs',import.meta.url),'utf8');
const wav = await readFile(resolve(process.argv[3]));
let wasmRequests = 0;
const server=createServer(async(req,res)=>{try{
 const path=new URL(req.url,'http://localhost').pathname;
 if(req.method==='POST'&&path==='/report') {let body='';for await(const c of req)body+=c;console.log('BROWSER REPORT',body);res.end('ok');return;}
 if(path==='/'){res.setHeader('Content-Type','text/html');res.end('<!doctype html><meta charset="utf-8"><title>Wfloat VAD integration</title><h1>Wfloat VAD integration</h1><button id="run">Run VAD checks</button><button id="mic">Run microphone check (after model tests)</button><pre id="out">Ready</pre><script type="module" src="/client.js"></script>');return;}
 if(path==='/favicon.ico'){res.writeHead(204).end();return;}
 if(path==='/fixture.wav'){res.setHeader('Content-Type','audio/wav');res.end(wav);return;}
 if(path.endsWith('.wasm')){wasmRequests++;res.setHeader('Content-Type','application/wasm');res.end(await readFile('src/wasm/sherpa-onnx-wasm-main-speech.wasm'));return;}
 const content=path==='/client.js'?client:files.get(path);
 if(!content){res.writeHead(404).end();return;}
 res.setHeader('Content-Type','text/javascript');res.end(content);
}catch(error){res.writeHead(500).end(String(error));}});
await new Promise(r=>server.listen(serve?8782:8783,'127.0.0.1',r));
const url=`http://127.0.0.1:${server.address().port}`;
if(serve){console.log('READY',url);}else{
 const {chromium}=await import(pathToFileURL(resolve(process.argv[2])));
 const browser=await chromium.launchPersistentContext('/tmp/wfloat-vad-chrome',{ executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true,
 args:['--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream',`--use-file-for-fake-audio-capture=${resolve(process.argv[3])}`]});
 try{
  const page=await browser.newPage();const errors=[];
  page.on('pageerror',e=>{errors.push(String(e));console.error('PAGE ERROR',String(e));});
  page.on('console',m=>{if(m.type()==='error'||m.type()==='warning'||m.text().startsWith('VAD'))console.log(m.type(),m.text());});
  await page.goto(url);await page.waitForFunction(()=>window.vadReady);await page.click('#run');
  await page.waitForFunction(()=>window.vadReport?.done,undefined,{timeout:900000});
  const report=await page.evaluate(()=>window.vadReport);console.log(JSON.stringify(report,null,2));
  if(report.failed)throw Error('VAD browser checks failed');
  await page.click('#mic');await page.waitForFunction(()=>window.micReport?.done,undefined,{timeout:180000});
  const microphone=await page.evaluate(()=>window.micReport);console.log('MIC',JSON.stringify(microphone));
  if(microphone.failed)throw Error('VAD microphone check failed');
  if(errors.length)throw Error(errors.join('\n'));
  console.log('PASS real browser VAD',JSON.stringify({wasmRequests}));
 }finally{await browser.close();await new Promise(r=>server.close(r));}
}
