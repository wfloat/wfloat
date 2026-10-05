// Real Chromium + WASM smoke. No packages are installed by this script.
// node browser-smoke.mjs BUILD_DIR MODEL_GGUF PLAYWRIGHT_MODULE
import { createServer } from 'node:http';
import { readFile, mkdtemp, writeFile, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
const here = dirname(fileURLToPath(import.meta.url));
const pkg = resolve(here, '../..');
const [buildDir, modelPath, playwrightPath] = process.argv.slice(2);
if (!playwrightPath) throw new Error('Expected BUILD_DIR MODEL_GGUF PLAYWRIGHT_MODULE');
const { build } = await import(pathToFileURL(resolve(pkg, 'node_modules/esbuild/lib/main.js')));
const { chromium } = await import(pathToFileURL(resolve(playwrightPath)));
const dir = await mkdtemp(join(tmpdir(), 'wfloat-native-browser-'));
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
  const result = await page.evaluate(async () => {
    const { createNativeBackend } = await import('/bridge.js');
    const model = await (await fetch('/model.gguf')).blob();
    const wasmBinary = new Uint8Array(await (await fetch('/runtime.wasm')).arrayBuffer());
    console.log('Loading real GGUF');
    const modelBytes = await model.arrayBuffer();
    const runtimeBytes = wasmBinary.slice();
    const backend = await createNativeBackend({ model: modelBytes, wasmBinary: runtimeBytes, contextSize: 512 });
    if (modelBytes.byteLength !== 0 || runtimeBytes.byteLength !== 0) throw new Error('Model/runtime load buffers were not transferred');
    const assert = (value, message) => { if (!value) throw new Error(message); };
    const request = { messages: [{ role: 'user', content: 'Say hello.' }], temperature: 0, maxTokensPerRound: 8 };
    const input = await backend.countInputTokens(request);
    const run = async req => { const events = []; for await (const event of backend.generateRound(req)) events.push(event); return events; };
    console.log('Generating real tokens');
    const first = await run(request), second = await run(request);
    assert(first.some(e => e.type === 'text' && e.text.length), 'No generated text');
    assert(first.at(-1).inputTokens === input, 'Formatted count mismatch');
    assert(first[0].type === 'usage' && first[0].inputTokens === input, 'No initial usage snapshot');
    let latestUsage;
    for (const event of first) {
      if (event.type === 'usage') latestUsage = event;
      if (event.type === 'text') assert(latestUsage?.outputTokens > 0, 'Content preceded its usage snapshot');
    }
    assert(second.at(-1).cachedInputTokens > 0, 'No KV prefix reuse');
    assert(first.filter(e => e.type === 'text').map(e => e.text).join('') === second.filter(e => e.type === 'text').map(e => e.text).join(''), 'KV reuse changed greedy output');
    const noReasoning = await run({ ...request, reasoning: false, maxTokensPerRound: 1 });
    assert(!noReasoning.some(e => e.type === 'warning'), 'Non-reasoning model warned for reasoning:false');
    const requestedReasoning = await run({ ...request, reasoning: true, maxTokensPerRound: 1 });
    assert(requestedReasoning.some(e => e.type === 'warning'), 'Non-reasoning model did not warn for reasoning:true');
    const schema = { type: 'object', properties: { answer: { const: 'yes' } }, required: ['answer'], additionalProperties: false };
    const constrained = await run({ messages: [{ role: 'user', content: 'Answer yes using JSON.' }], jsonSchema: schema, temperature: 0, maxTokensPerRound: 40 });
    const answer = constrained.filter(e => e.type === 'text').map(e => e.text).join('');
    assert((await backend.validateSchema(schema, JSON.parse(answer))).valid, 'Constrained output invalid');
    const cancelled = [], controller = new AbortController();
    for await (const event of backend.generateRound({ ...request, maxTokensPerRound: 100 }, controller.signal)) {
      cancelled.push(event);
      if (event.type === 'text') {
        assert(await backend.countInputTokens(request) === input, 'Concurrent count mutated formatting');
        assert((await backend.checkSchema(schema)).valid, 'Concurrent schema failed');
        controller.abort();
      }
    }
    assert(cancelled.at(-1).stopReason === 'cancelled', 'Abort did not stop native round');
    assert(cancelled.at(-1).outputTokens > 0, 'Abort lost token counts');
    const prefillAbort = new AbortController(), interruptedPrefill = [];
    for await (const event of backend.generateRound({ messages: [{ role: 'user', content: 'hello '.repeat(300) }] }, prefillAbort.signal)) {
      interruptedPrefill.push(event);
      if (event.type === 'usage') prefillAbort.abort();
    }
    assert(interruptedPrefill.at(-1).stopReason === 'cancelled' && interruptedPrefill.at(-1).outputTokens === 0, 'Prefill abort decoded output');
    const oversized = { messages: [{ role: 'user', content: 'hello '.repeat(700) }] };
    assert(await backend.countInputTokens(oversized) > 512, 'Oversized count must succeed');
    const over = await run(oversized);
    assert(over.at(-1).stopReason === 'contextLimit' && over.at(-1).outputTokens === 0, 'Input overflow mishandled');
    let rejected = false;
    try { await backend.countInputTokens({ ...request, jsonSchema: schema, tools: [{ type: 'function', function: { name: 'test', parameters: schema } }] }); } catch { rejected = true; }
    assert(rejected, 'Tools + structured output accepted');
    await backend.unload();
    const abortLoad = new AbortController();
    const loading = createNativeBackend({ model, wasmBinary: wasmBinary.slice(), contextSize: 512, signal: abortLoad.signal });
    abortLoad.abort();
    rejected = false; try { await loading; } catch (error) { rejected = error.name === 'AbortError'; }
    assert(rejected, 'Load abort failed');
    return { input, first, second, constrained, cancelled, interruptedPrefill, over, loadAbort: true };
  });
  console.log(JSON.stringify(result, null, 2));
  await writeFile(join(dir, 'result.json'), JSON.stringify(result, null, 2));
  console.log(`Smoke evidence: ${dir}/result.json`);
  console.log('Model SHA256:', createHash('sha256').update(await readFile(modelPath)).digest('hex'));
} finally { await browser.close(); server.close(); }
