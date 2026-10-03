// Optional tiny real-browser smoke. No model downloads or package build.
import { build } from 'esbuild';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
const dir=await mkdtemp(join(tmpdir(),'wfloat-assets-browser-'));
let reportResult;
const reported=new Promise(resolve=>{reportResult=resolve;});
const server=createServer(async(req,res)=>{
  if(req.url==='/report') {let body='';for await(const chunk of req) body+=chunk;reportResult(JSON.parse(body));res.end('ok');return;}
  if(req.url==='/fixture') { const body=Buffer.from('tiny browser asset fixture');res.writeHead(200,{'Content-Length':body.length});res.end(body); }
  else if(req.url==='/test.js') {res.setHeader('Content-Type','text/javascript');res.end(await readFile(join(dir,'test.js')));}
  else {res.setHeader('Content-Type','text/html');res.end('<!doctype html><body><pre>running</pre><script type="module" src="/test.js"></script>');}
});
try {
  await build({entryPoints:[new URL('./browser.test.mjs',import.meta.url).pathname],outfile:join(dir,'test.js'),bundle:true,format:'esm',platform:'browser'});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const chrome=process.env.CHROME_BINARY ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  const child=spawn(chrome,['--headless','--disable-gpu','--no-first-run','--disable-background-networking','--disable-sync','--disable-extensions',`--user-data-dir=${join(dir,'profile')}`,`http://127.0.0.1:${server.address().port}`]);
  let errors='';child.stderr.on('data',d=>errors+=d);
  let timeout;
  const outcome=await Promise.race([reported,new Promise(resolve=>{timeout=setTimeout(()=>resolve({result:'timeout',text:errors}),30000);}),
    new Promise(resolve=>child.on('error',error=>resolve({result:'error',text:String(error)})))]);
  clearTimeout(timeout);console.log(outcome.text);
  if(outcome.result!=='pass') {console.error(errors);process.exitCode=1;}
  child.kill('SIGTERM');await new Promise(resolve=>child.on('exit',resolve));
} finally {server.close();await rm(dir,{recursive:true,force:true,maxRetries:5,retryDelay:200});}
