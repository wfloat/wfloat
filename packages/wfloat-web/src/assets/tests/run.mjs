// Run from any directory: node packages/wfloat-web/src/assets/tests/run.mjs
// Compile only this asset test graph into an ephemeral, small bundle.
import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
const dir = await mkdtemp(join(tmpdir(), 'wfloat-assets-test-'));
try {
  const outfile = join(dir, 'assets.test.mjs');
  await build({ entryPoints: [new URL('./assets.test.mjs', import.meta.url).pathname], outfile,
    bundle: true, platform: 'node', format: 'esm', target: 'node22' });
  const run = spawnSync(process.execPath, ['--test', outfile], { stdio: 'inherit' });
  process.exitCode = run.status ?? 1;
} finally { await rm(dir, { recursive: true, force: true }); }
