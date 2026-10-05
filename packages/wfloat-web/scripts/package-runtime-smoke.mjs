// Optional real runtime check of the installed npm tarball's Vite production output.
// WFLOAT_SMOKE_PLAYWRIGHT=/path/to/playwright/index.mjs WFLOAT_SMOKE_MODEL=/path/to/registry-model.gguf
// node scripts/package-browser-smoke.mjs (after npm run build:dev)
import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { join, resolve, extname, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
export async function runPackedRuntimeSmoke(consumerDir, playwrightPath, modelPath) {
 const root=resolve(consumerDir,'dist');let requests=0;
 const server=createServer(async(req,res)=>{
  try {
   const path=new URL(req.url,'http://localhost').pathname;
   const model=path==='/fixture-model.gguf';
   const file=model?resolve(modelPath):resolve(root,'.'+(path==='/'?'/index.html':path));
   if(!model&&!file.startsWith(root+sep)){res.writeHead(403).end();return;}
   const info=await stat(file);if(!info.isFile()){res.writeHead(404).end();return;}
   if(model)requests++;
   res.setHeader('Access-Control-Allow-Origin','*');res.setHeader('Content-Length',info.size);
   res.setHeader('Content-Type',({'.html':'text/html','.js':'text/javascript','.wasm':'application/wasm','.css':'text/css'})[extname(file)]??'application/octet-stream');
   createReadStream(file).pipe(res);
  } catch {res.writeHead(404).end();}
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const origin=`http://127.0.0.1:${server.address().port}`;
 const {chromium}=await import(pathToFileURL(resolve(playwrightPath)));
 let browser;
 try {
  browser=await chromium.launch({executablePath:process.env.WFLOAT_SMOKE_CHROME??'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
  const page=await browser.newPage();const errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.route('https://registry.wfloat.com/models/**',route=>route.fulfill({status:302,headers:{location:origin+'/fixture-model.gguf','access-control-allow-origin':'*'}}));
  await page.goto(origin);
  await page.waitForFunction(()=>!!window.__wfloatSmoke?.loadLanguageModel);
  const result=await page.evaluate(async()=>{
   const sdk=window.__wfloatSmoke,events=[];
   const model=await sdk.loadLanguageModel('HuggingFaceTB/SmolLM2-360M-Instruct',{contextSize:256,persistence:'off',onProgress:e=>events.push(e.phase)});
   try {
    const messages=[{role:'user',content:'Say hello.'}];
    const generated=await model.generate(messages,{temperature:0,maxTokensPerRound:4}).result();
    if(!generated.text||!generated.usage.outputTokens)throw Error('Packed SDK produced no text');
    if(events[0]!=='checking'||events.at(-1)!=='ready')throw Error('Missing load phases');
    return {text:generated.text,usage:generated.usage,phases:[...new Set(events)],progressEvents:events.length};
   }finally{await model.unload();}
  });
  if(errors.length)throw Error('Packed browser errors: '+errors.join('; '));
  if(requests!==1)throw Error(`Expected one local model fetch, got ${requests}`);
  console.log('PASS packed Vite runtime',JSON.stringify(result));
 }finally{await browser?.close();await new Promise(r=>server.close(r));}
}
