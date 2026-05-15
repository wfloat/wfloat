import { build } from "esbuild";
import { readFile, rm, writeFile } from "fs/promises";
import { resolve } from "path";
import { fileURLToPath } from "url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

const entry = resolve(__dirname, "../src/worker/worker.ts");
const outfile = resolve(__dirname, "../dist/worker/worker-bundled.js");
const finalOutfile = resolve(__dirname, "../dist/worker/worker-inline.js");

async function run() {
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
