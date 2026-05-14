// scripts/build-worker-inline.mjs
import { build } from "esbuild";
import { readFile, writeFile } from "fs/promises";
import { resolve } from "path";
import { fileURLToPath } from "url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

const entry = resolve(__dirname, "../src/worker/worker.ts");
const outfile = resolve(__dirname, "../dist/worker/worker-bundled.js");
const finalOutfile = resolve(__dirname, "../dist/worker/worker-inline.js");

async function run() {
    // 1. Bundle worker into a single JS file
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

    // 2. Read bundled output
    const bundledCode = await readFile(outfile, "utf8");

    // 3. Convert to JS module exporting string
    const escaped = JSON.stringify(bundledCode);

    const wrapped = `// Auto-generated. Do not edit.
export default ${escaped};
`;

    await writeFile(finalOutfile, wrapped, "utf8");

    console.log("✓ worker-inline.js generated");
}

run().catch((err) => {
    console.error(err);
    process.exit(1);
});