import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { auditPack } from '../verify-native-package.mjs';

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
test('npm pack retains Android build configuration but excludes build output', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'wfloat-pack-files-'));
  try {
    const { files } = JSON.parse(readFileSync(path.join(packageDir, 'package.json'), 'utf8'));
    writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'pack-fixture', version: '1.0.0', files }));
    for (const file of ['android/build.gradle', 'android/gradle.properties', 'android/consumer-rules.pro',
      'android/build/output.so', 'android/build-old/output.so']) {
      mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      writeFileSync(path.join(root, file), 'fixture');
    }
    const [packed] = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: root, encoding: 'utf8' }));
    const paths = packed.files.map(file => file.path);
    for (const file of ['android/build.gradle', 'android/gradle.properties', 'android/consumer-rules.pro']) {
      assert.ok(paths.includes(file), `Missing ${file}`);
    }
    assert.ok(!paths.includes('android/build/output.so'));
    assert.ok(!paths.includes('android/build-old/output.so'));
    assert.ok(auditPack(paths.filter(file => file !== 'android/build.gradle')).includes('Missing packed file: android/build.gradle'));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
