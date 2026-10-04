import { createHash } from 'node:crypto';
import { build } from 'esbuild';
import { access, writeFile, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
export async function buildNextWorkers({ release, sherpaWasmUrl, llamaWasmUrl }) {
  if (release) {
    await writeFile(resolve(root, 'dist/runtime/urls.js'), `import { configureRuntimeAssets } from '../assets/manifest.js';\nexport const SHERPA_WASM_URL = ${JSON.stringify(sherpaWasmUrl)};\nexport const LLAMA_WASM_URL = ${JSON.stringify(llamaWasmUrl)};\nconfigureRuntimeAssets('speech', [{url:SHERPA_WASM_URL}]);\nconfigureRuntimeAssets('llama', [{url:LLAMA_WASM_URL}]);\n`);
  }
  if (!release) {
    const sherpaHash = createHash('sha256').update(await readFile(resolve(root, 'src/wasm/sherpa-onnx-wasm-main-speech.wasm'))).digest('hex');
    const llamaHash = createHash('sha256').update(await readFile(resolve(root, 'src/wasm/wfloat-llama-wasm.wasm'))).digest('hex');
    await writeFile(resolve(root, 'dist/runtime/urls.js'), `import { configureRuntimeAssets } from '../assets/manifest.js';\nexport const SHERPA_WASM_URL = new URL('../wasm/sherpa-onnx-wasm-main-speech.wasm?sha256=${sherpaHash}', import.meta.url).href;\nexport const LLAMA_WASM_URL = new URL('../wasm/wfloat-llama-wasm.wasm?sha256=${llamaHash}', import.meta.url).href;\nconfigureRuntimeAssets('speech', [{url:SHERPA_WASM_URL,sha256:'${sherpaHash}'}]);\nconfigureRuntimeAssets('llama', [{url:LLAMA_WASM_URL,sha256:'${llamaHash}'}]);\n`);
  }
  for (const [entry, output] of [
    ['src/llm-native/worker.ts', 'dist/llm-native/llm-native-worker.js'],
    ['src/tts-next/worker.ts', 'dist/tts-next/tts-worker.js'],
    ['src/stt-next/worker.ts', 'dist/stt-next/stt-worker.js'],
    ['src/vad-next/worker.ts', 'dist/vad-next/vad-worker.js'],
  ]) {
    await access(resolve(root, entry));
    await build({entryPoints:[resolve(root,entry)],outfile:resolve(root,output),bundle:true,platform:'browser',format:'esm',target:'es2020',minify:release,
      define:{ WFLOAT_WEB_USE_LOCAL_WASM: String(!release), WFLOAT_WEB_SHERPA_WASM_URL:JSON.stringify(sherpaWasmUrl ?? ''), WFLOAT_WEB_LLAMA_WASM_URL:JSON.stringify(llamaWasmUrl ?? '') }});
  }
}
