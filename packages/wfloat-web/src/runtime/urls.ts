import { configureRuntimeAssets } from '../assets/manifest.js';

// Release builds replace this module with immutable publication URLs. Development
// builds resolve the local artifacts copied by copy-runtime-assets.sh.
export const SHERPA_WASM_URL = new URL('../wasm/sherpa-onnx-wasm-main-speech.wasm', import.meta.url).href;
export const LLAMA_WASM_URL = new URL('../wasm/wfloat-llama-wasm.wasm', import.meta.url).href;
configureRuntimeAssets('speech', [{ url: SHERPA_WASM_URL }]);
configureRuntimeAssets('llama', [{ url: LLAMA_WASM_URL }]);
