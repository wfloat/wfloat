// Kitten-only bounded smoke using the freshly built WASM and Web adapter.
// Run sequentially, in a fresh Node process per model. Does not copy runtime
// artifacts into src/wasm. Model/eSpeak inputs are read-only; reports and WAVs
// are written to the explicitly selected output directory. See --help.
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { parseArgs } from 'node:util';

const here=path.dirname(fileURLToPath(import.meta.url));
const sdk=path.resolve(here,'../../../..');
const { values, positionals } = parseArgs({allowPositionals:true, options:{
  manifest:{type:'string'}, espeak:{type:'string'}, runtime:{type:'string'},
  output:{type:'string'}, help:{type:'boolean'},
}});
if (values.help) {
  console.log(`Usage: node qualify-wasm.mjs MODEL_ID --manifest FILE --espeak ZIP --output DIR [--runtime DIR]
MODEL_ID: KittenML/kitten-tts-nano-0.8 or KittenML/kitten-tts-mini-0.8
Environment alternatives: KITTEN_MANIFEST, KITTEN_ESPEAK, KITTEN_OUTPUT, KITTEN_RUNTIME.
Manifest: {models:[{modelId,assets:[{role,localPath,sha256}]}]}; required roles: model,tokens,voices.
Relative asset paths resolve against the manifest directory. Run with a process timeout.`);
  process.exit(0);
}
const modelId=positionals[0];
assert.equal(positionals.length,1,'provide exactly one model ID; use --help for options');
assert(['KittenML/kitten-tts-nano-0.8','KittenML/kitten-tts-mini-0.8'].includes(modelId),'exact Kitten 0.8 ID required');
const manifestInput=values.manifest??process.env.KITTEN_MANIFEST;
const espeakInput=values.espeak??process.env.KITTEN_ESPEAK;
const outputInput=values.output??process.env.KITTEN_OUTPUT;
assert(manifestInput&&espeakInput&&outputInput,'--manifest, --espeak and --output (or their environment variables) are required');
const manifestPath=path.resolve(manifestInput);
const espeakPath=path.resolve(espeakInput);
const runtime=path.resolve(values.runtime??process.env.KITTEN_RUNTIME??path.join(sdk,'vendor/sherpa-onnx/build-wasm-simd-speech/install/bin/wasm/speech'));
const destination=path.resolve(outputInput);
const web=path.join(sdk,'packages/wfloat-web');
const {build}=await import(pathToFileURL(path.join(web,'node_modules/esbuild/lib/main.js')));
await fs.mkdir(destination,{recursive:true});
const bundle=async relative=>{
  const result=await build({entryPoints:[path.join(web,relative)],bundle:true,write:false,platform:'node',format:'esm'});
  return import('data:text/javascript;base64,'+Buffer.from(result.outputFiles[0].text).toString('base64'));
};
const api=await bundle('src/tts-next/sherpa.ts');
const {standardConfig}=await bundle('src/tts-next/families.ts');
const manifest=JSON.parse(await fs.readFile(manifestPath,'utf8'));
const record=manifest.models.find(x=>x.modelId===modelId);
assert(record);
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const files={}; const assetHashes={};
for(const [role,key] of [['model','model_onnx'],['tokens','model_tokens'],['voices','model_voices']]) {
  const asset=record.assets.find(a=>a.role===role);assert(asset,role);
  const bytes=await fs.readFile(path.resolve(path.dirname(manifestPath),asset.localPath));
  assert.equal(hash(bytes),asset.sha256);
  files[key]=new Uint8Array(bytes);assetHashes[key]=asset.sha256;
}
const wasm=await fs.readFile(path.join(runtime,'sherpa-onnx-wasm-main-speech.wasm'));
const factoryText=await fs.readFile(path.join(runtime,'sherpa-onnx-wasm-main-speech.js'));
// Force ESM without renaming or overwriting build/source runtime fixtures.
const {default:createModule}=await import('data:text/javascript;base64,'+factoryText.toString('base64'));
const startedAt=new Date().toISOString();const logs=[];
const module=await createModule({locateFile:name=>name,wasmBinary:wasm,print:x=>logs.push(String(x)),printErr:x=>logs.push(String(x))});
const config=standardConfig(modelId);
const espeak=new Uint8Array(await fs.readFile(espeakPath));
const results=[];let tts;
const report={modelId,startedAt,runtime,wasmSha256:hash(wasm),factorySha256:hash(factoryText),assetHashes,results,logs};
try {
  tts=api.initializeSherpa(module,{family:'kitten',config,files,espeak,wasm:new Uint8Array()});
  assert.equal(tts.sampleRate,24000);assert.equal(tts.numSpeakers,8);
  for(const segment of [
    {text:'Hello, this is a short speech test.',voiceId:'Jasper'},
    {text:'The rate is 0.00001%.',voiceId:'Kiki'},
    {text:"Dr. Smith can't pay $12.50. The meeting starts at 9:05 AM.",voiceId:'Hugo',speed:1.1},
    {text:process.env.KITTEN_PROBE_TEXT??'Café, version GPT-3.5: one half! Is it ready?',voiceId:'Bella'},
  ].filter((_,i)=>!process.env.KITTEN_PROBE_TEXT||i===3)) {
    const start=performance.now();
    const units=api.prepareSherpa(module,tts,segment,config);
    assert.equal(units.length,1);assert.equal(units[0].text,segment.text);
    const audio=api.synthesizeSherpa(tts,units[0],segment,config);
    assert.equal(audio.sampleRate,24000);assert(audio.samples.length>0);assert(audio.samples.length<24000*45);
    let peak=0,squares=0;
    for(const sample of audio.samples){assert(Number.isFinite(sample));peak=Math.max(peak,Math.abs(sample));squares+=sample*sample;}
    assert(peak>0.001);assert(peak<10);
    const wav=Buffer.alloc(44+audio.samples.length*2);
    wav.write('RIFF');wav.writeUInt32LE(wav.length-8,4);wav.write('WAVEfmt ',8);
    wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);
    wav.writeUInt32LE(24000,24);wav.writeUInt32LE(48000,28);wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);
    wav.write('data',36);wav.writeUInt32LE(audio.samples.length*2,40);
    audio.samples.forEach((v,i)=>wav.writeInt16LE(Math.round(Math.max(-1,Math.min(1,v))*32767),44+2*i));
    const output=path.join(destination,modelId.replaceAll('/','--')+'-'+segment.voiceId+'.wav');
    await fs.writeFile(output,wav);
    const result={...segment,samples:audio.samples.length,seconds:audio.samples.length/24000,
      elapsedMs:performance.now()-start,peak,rms:Math.sqrt(squares/audio.samples.length),wav:output};
    results.push(result);console.log(JSON.stringify(result));
  }
  report.status='passed';
} catch(error) {report.status='failed';report.error=String(error);throw error;}
finally {
  tts?.free();report.finishedAt=new Date().toISOString();report.heapBytes=module.HEAP8.buffer.byteLength;
  await fs.writeFile(path.join(destination,modelId.replaceAll('/','--')+'.json'),JSON.stringify(report,null,2)+'\n');
}
