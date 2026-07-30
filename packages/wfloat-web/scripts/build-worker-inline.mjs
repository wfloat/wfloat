import { build } from "esbuild";
import { readFile, rm, writeFile } from "fs/promises";
import { resolve } from "path";
import { fileURLToPath } from "url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

const entry = resolve(__dirname, "../src/worker/worker.ts");
const outfile = resolve(__dirname, "../dist/worker/worker-bundled.js");
const finalOutfile = resolve(__dirname, "../dist/worker/worker-inline.js");

function requiredWasmUrl(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required for a release worker build`);
  }

  const url = new URL(value);
  if (url.protocol !== "https:") {
    throw new Error(`${name} must be an HTTPS URL`);
  }

  return url.toString();
}

async function run() {
  const sherpaWasmUrl = requiredWasmUrl("WFLOAT_WEB_SHERPA_WASM_URL");
  const llamaWasmUrl = requiredWasmUrl("WFLOAT_WEB_LLAMA_WASM_URL");

  await build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    platform: "browser",
    format: "esm",
    target: "es2020",
    sourcemap: false,
    minify: true,
    treeShaking: true,
    define: {
      WFLOAT_WEB_USE_LOCAL_WASM: "false",
      WFLOAT_WEB_SHERPA_WASM_URL: JSON.stringify(sherpaWasmUrl),
      WFLOAT_WEB_LLAMA_WASM_URL: JSON.stringify(llamaWasmUrl),
    },
  });

  const bundledCode = await readFile(outfile, "utf8");
  const wrapped = `// Auto-generated. Do not edit.\nexport default ${JSON.stringify(bundledCode)};\n`;

  await writeFile(finalOutfile, wrapped, "utf8");
  await rm(outfile, { force: true });
  console.log("Copied bundled worker into dist/worker/worker-inline.js");
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
