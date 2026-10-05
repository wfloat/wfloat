// Extended real Chromium + WASM boundary experiments. No packages are installed by this script.
// node browser-experiments.mjs BUILD_DIR MODEL_GGUF PLAYWRIGHT_MODULE [SCENARIO_REGEX]
import { createServer } from 'node:http';
import { readFile, mkdtemp, writeFile, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const here = dirname(fileURLToPath(import.meta.url));
const pkg = resolve(here, '../..');
const [buildDir, modelPath, playwrightPath, filter = ""] = process.argv.slice(2);
if (!playwrightPath) throw new Error('Expected BUILD_DIR MODEL_GGUF PLAYWRIGHT_MODULE');
const { build } = await import(pathToFileURL(resolve(pkg, 'node_modules/esbuild/lib/main.js')));
const { chromium } = await import(pathToFileURL(resolve(playwrightPath)));
const dir = await mkdtemp(join(tmpdir(), 'wfloat-native-experiments-'));
const plugins = [{ name: 'built-wasm', setup(b) { b.onResolve({ filter: /wfloat-llama-wasm\.js$/ }, () => ({ path: resolve(buildDir, 'wfloat-llama-wasm.js') })); } }];
await build({ entryPoints: [resolve(pkg, 'src/llm-native/worker.ts')], outfile: join(dir, 'llm-native-worker.js'), bundle: true, format: 'esm', plugins });
await build({ entryPoints: [resolve(pkg, 'src/llm-native/bridge.ts')], outfile: join(dir, 'bridge.js'), bundle: true, format: 'esm' });
await copyFile(resolve(buildDir, 'wfloat-llama-wasm.wasm'), join(dir, 'runtime.wasm'));
await writeFile(join(dir, 'index.html'), '<!doctype html><title>Wfloat native smoke</title>');
const server = createServer(async (req, res) => {
  try {
    if (req.url === '/favicon.ico') { res.writeHead(204).end(); return; }
    const path = req.url === '/model.gguf' ? resolve(modelPath) : join(dir, req.url === '/' ? 'index.html' : req.url.slice(1));
    const bytes = await readFile(path);
    res.setHeader('Content-Type', path.endsWith('.html') ? 'text/html' : path.endsWith('.js') ? 'text/javascript' : path.endsWith('.wasm') ? 'application/wasm' : 'application/octet-stream');
    res.end(bytes);
  } catch { res.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
try {
  const page = await browser.newPage();
  page.on('pageerror', error => console.error('PAGE', error));
  page.on('console', message => { console.error('CONSOLE', message.text()); });
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  const template = await readFile(resolve(pkg, '../../vendor/llama.cpp/models/templates/Qwen-Qwen3-0.6B.jinja'), 'utf8');
  const result = await page.evaluate(async ({template, filter}) => {
    const { createNativeBackend } = await import('/bridge.js');
    const model = await (await fetch('/model.gguf')).blob();
    const wasmBinary = new Uint8Array(await (await fetch('/runtime.wasm')).arrayBuffer());
    const report = [];
    const assert = (value, message) => { if (!value) throw new Error(message); };
    const scenario = async (name, fn) => {
      if(filter && !new RegExp(filter).test(name)) return;
      console.log('EXPERIMENT', name);
      try { report.push({ name, passed: true, evidence: await fn() }); }
      catch (error) { report.push({ name, passed: false, error: error.message }); }
    };
    const backend = await createNativeBackend({model, wasmBinary: wasmBinary.slice(), contextSize:512});
    const run = async (req, target = backend) => { const events=[]; for await (const e of target.generateRound(req)) events.push(e); return events; };
    const text = events => events.filter(e=>e.type==='text').map(e=>e.text).join('');
    const base = { messages:[{role:'user',content:'Say hello.'}], temperature:0, maxTokensPerRound:12 };
    try {
      await scenario('changed prefixes, shorter history, and count isolation', async()=>{
        const first = await run(base);
        await run({...base,messages:[{role:'system',content:'Speak French.'},...base.messages]});
        await backend.countInputTokens({...base,messages:[{role:'user',content:'unrelated '.repeat(300)}]});
        const again=await run(base), repeat=await run(base);
        assert(text(first)===text(again)&&text(first)===text(repeat),'Changed cache changed greedy output');
        assert(repeat.at(-1).cachedInputTokens===repeat.at(-1).inputTokens-1,'Exact prefix not reused');
        return {text:text(first),changed:again.at(-1),repeated:repeat.at(-1)};
      });
      await scenario('early iterator return tears down before next round',async()=>{
        for await(const e of backend.generateRound({...base,maxTokensPerRound:100})) if(e.type==='text') break;
        const events=await run(base); assert(text(events).length,'No recovery'); return events.at(-1);
      });
      await scenario('schema changes with identical formatted prefix reset grammar and sampler',async()=>{
        const evidence=[];
        for(const answer of ['yes','no','yes','你好🌍']) {
          const req={...base,jsonSchema:{const:answer},maxTokensPerRound:24};
          const count=await backend.countInputTokens(req),events=await run(req);
          assert(JSON.parse(text(events))===answer,`Wrong answer after grammar change: ${text(events)}`);
          assert(events.at(-1).inputTokens===count,'Schema count mismatch');
          evidence.push({answer,done:events.at(-1)});
        }
        const seeded={...base,temperature:0.7,seed:42,maxTokensPerRound:6};
        const first=await run(seeded),second=await run(seeded);
        assert(text(first)===text(second),'Seeded sampler/cache changed repeat output');
        return {evidence,seeded:text(first)};
      });
      await scenario('nested any-JSON array accepts scalar values',async()=>{
        const evidence=[];
        for(const items of [{},true]) {
          const req={...base,messages:[{role:'user',content:'Return exactly this JSON array: ["yes"]'}],
            jsonSchema:{type:'array',items,minItems:1,maxItems:1},temperature:0.7,seed:42,maxTokensPerRound:32};
          const events=await run(req),answer=text(events);
          const value=JSON.parse(answer);
          assert(Array.isArray(value)&&value.length===1&&(value[0]===null||typeof value[0]!=='object'),`Expected scalar array item: ${answer}`);
          assert((await backend.validateSchema(req.jsonSchema,value)).valid,'Array failed original-schema validation');
          evidence.push({items,answer,done:events.at(-1)});
        }
        return evidence;
      });
      await scenario('scalar and empty JSON schemas' ,async()=>{
        const evidence=[];
        for(const jsonSchema of [{const:'yes'},{type:'array',items:{const:1},minItems:2,maxItems:2},{}]) {
          const events=await run({...base,messages:[{role:'user',content:'Respond in JSON.'}],jsonSchema,maxTokensPerRound:24});
          const answer=text(events);
          if(events.at(-1).stopReason==='complete') assert((await backend.validateSchema(jsonSchema,JSON.parse(answer))).valid,`Constraint not satisfied: ${answer}`);
          else assert(events.at(-1).stopReason==='maxTokens' && events.at(-1).outputTokens===24,'Unexpected schema boundary');
          evidence.push({jsonSchema,answer,done:events.at(-1)});
        } return evidence;
      });
    } finally {await backend.unload();await backend.unload();}
    await scenario('pre-aborted load has AbortError',async()=>{
      const controller=new AbortController();controller.abort();
      let error;try{await createNativeBackend({model,wasmBinary:wasmBinary.slice(),contextSize:512,signal:controller.signal});}catch(e){error=e;}
      assert(error?.name==='AbortError',`Expected AbortError, got ${error?.name}: ${error?.message}`);return error.name;
    });
    await scenario('any-JSON schemas constrain default and reasoning templates',async()=>{
      const evidence=[];
      for(const chatTemplate of [undefined,template]) {
        const target=await createNativeBackend({model,wasmBinary:wasmBinary.slice(),contextSize:512,chatTemplate});
        try {
          for(const jsonSchema of [{},true]) {
            const req={...base,messages:[{role:'user',content:'Say hello. Do not use JSON.'}],jsonSchema,reasoning:false,maxTokensPerRound:24};
            const events=await run(req,target),answer=text(events);
            assert(/^[\s]*["{[0-9tfn-]/.test(answer),`JSON grammar ignored: ${answer}`);
            if(events.at(-1).stopReason==='complete') JSON.parse(answer);
            evidence.push({template:chatTemplate?'Qwen':'GGUF',jsonSchema,answer,done:events.at(-1)});
          }
          let rejected=false;
          try {await target.countInputTokens({...base,jsonSchema:false});}catch(e){rejected=/permits no output/.test(e.message);}
          assert(rejected,'False schema did not fail explicitly');
          const after=await run({...base,jsonSchema:{const:'recovered'},maxTokensPerRound:24},target);
          assert(JSON.parse(text(after))==='recovered','False schema failure damaged next grammar');
        } finally {await target.unload();}
      }return evidence;
    });
    await scenario('Qwen reasoning template with constrained answer',async()=>{
      const target=await createNativeBackend({model,wasmBinary:wasmBinary.slice(),contextSize:512,chatTemplate:template});
      try {
        const evidence=[];
        for(const reasoning of [false,true]) {
          const req={...base,messages:[{role:'user',content:'Answer yes.'}],reasoning,jsonSchema:{type:'object',properties:{answer:{const:'yes'}},required:['answer'],additionalProperties:false},maxTokensPerRound:60};
          const count=await target.countInputTokens(req),events=await run(req,target);
          assert(events.at(-1).inputTokens===count,'Reasoning formatted count mismatch');
          assert(!events.some(e=>e.type==='warning'),'Switchable template warned');
          if(!reasoning) assert(JSON.parse(text(events)).answer==='yes','Disabled reasoning constraint failed');
          evidence.push({reasoning,text:text(events),reasoningText:events.filter(e=>e.type==='reasoning').map(e=>e.text).join(''),done:events.at(-1)});
        } return evidence;
      } finally {await target.unload();}
    });
    return report;
  }, {template, filter});
  console.log(JSON.stringify(result, null, 2));
  await writeFile(join(dir, 'result.json'), JSON.stringify(result, null, 2));
  console.log(`Experiment evidence: ${dir}/result.json`);
  if(result.some(r=>!r.passed)) process.exitCode=1;
} finally { await browser.close(); server.close(); }
