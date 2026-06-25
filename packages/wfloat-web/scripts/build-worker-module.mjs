import { build } from "esbuild";
import { mkdir, writeFile } from "fs/promises";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

const entry = resolve(__dirname, "../src/worker/worker.ts");
const outfile = resolve(__dirname, "../dist/worker/worker.js");
const createWorkerOutfile = resolve(__dirname, "../dist/worker/createWorker.js");

async function run() {
  await build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    platform: "browser",
    format: "esm",
    target: "es2020",
    sourcemap: false,
    minify: false,
    treeShaking: true,
    define: {
      WFLOAT_WEB_USE_LOCAL_WASM: "true",
    },
  });

  await mkdir(dirname(createWorkerOutfile), { recursive: true });
  await writeFile(
    createWorkerOutfile,
    `export function createWfloatWorker() {\n  return new Worker(new URL("./worker.js", import.meta.url), { type: "module" });\n}\n`,
    "utf8",
  );

  console.log("Built module worker into dist/worker/worker.js");
  console.log("Wrote module worker loader into dist/worker/createWorker.js");
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
