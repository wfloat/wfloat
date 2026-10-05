// Explicit local qualification tool, not part of unit tests. Loads sessions only;
// never decodes audio or downloads assets. Pass the staged publication manifest.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { build } from '../../node_modules/esbuild/lib/main.js';
import createModule from '../../src/wasm/sherpa-onnx-wasm-main-speech.js';
const manifest = JSON.parse(await readFile(process.argv[2], 'utf8'));
const id = process.argv[3] ?? 'moonshine-ai/moonshine-base';
if (!['moonshine-ai/moonshine-base', 'openai/whisper-tiny'].includes(id)) throw Error('This bounded probe supports Moonshine Base or multilingual Whisper Tiny only.');
const model = manifest.models.find(m => m.model_id === id);
if (!model) throw Error('The requested model must be in the staged manifest.');
const assets = {};
for (const asset of model.assets.filter(a => ['tokens', 'encoder', 'decoder', 'merged_decoder'].includes(a.role))) {
  const bytes = new Uint8Array(await readFile(asset.local_file));
  if (bytes.length !== asset.size_bytes || createHash('sha256').update(bytes).digest('hex') !== asset.sha256) throw Error(`Staged hash mismatch: ${asset.role}`);
  assets[asset.role] = bytes;
}
const compiled = await build({ entryPoints: [new URL('../../src/stt-next/sherpa.ts', import.meta.url).pathname], bundle: true, write: false, platform: 'node', format: 'esm' });
const { SherpaRecognizer, NativeDiagnostics } = await import('data:text/javascript;base64,' + Buffer.from(compiled.outputFiles[0].text).toString('base64'));
const diagnostics = new NativeDiagnostics();
const wasm = await readFile(new URL('../../src/wasm/sherpa-onnx-wasm-main-speech.wasm', import.meta.url));
const module = await createModule({ wasmBinary: wasm, print: diagnostics.print, printErr: message => { diagnostics.print(message); console.error(message); } });
const recognizer = new SherpaRecognizer(module, model.model_id, assets, diagnostics);
assert.equal(module.FS.readdir('/').some(name => /^(tokens\.txt|encoder\.|decoder\.|merged_decoder\.)/.test(name)), false, 'offline files must be unlinked');
if (id === 'openai/whisper-tiny') {
  recognizer.configure({ language: 'fr-FR', task: 'translate', timestamps: 'segment' });
  recognizer.configure({ language: 'zh-CN', task: 'transcribe' });
  recognizer.configure({});
}
recognizer.unload();
console.log(JSON.stringify({ model: model.model_id, result: 'loaded-and-unloaded', audio_inference: false, offline_files_unlinked: true, whisper_reconfigured_after_unlink: id === 'openai/whisper-tiny', wasm_sha256: createHash('sha256').update(wasm).digest('hex'), wasm_bytes: wasm.length }));
