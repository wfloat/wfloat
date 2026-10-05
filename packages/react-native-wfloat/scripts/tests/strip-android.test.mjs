import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { stripAndroid } from '../strip-android-symbols.mjs';

test('strip Android libraries without changing their runtime interface', {
  skip: !process.env.ANDROID_NDK_HOME && 'Requires an Android NDK; runs in native CI.',
}, () => {
  const root = mkdtempSync(path.join(tmpdir(), 'wfloat-strip-test-'));
  try {
    const prebuilt = path.join(process.env.ANDROID_NDK_HOME, 'toolchains/llvm/prebuilt');
    const host = readdirSync(prebuilt).find(x => existsSync(path.join(prebuilt, x, 'bin/llvm-strip')));
    const bin = path.join(prebuilt, host, 'bin');
    const jni = path.join(root, 'jni');
    const symbols = path.join(root, 'symbols');
    const source = path.join(root, 'fixture.c');
    writeFileSync(source, 'static int helper(int x) { return x + 1; }\nint public_function(int x) { return helper(x); }\n');
    for (const [abi, target] of Object.entries({
      'arm64-v8a': 'aarch64-linux-android',
      'armeabi-v7a': 'armv7a-linux-androideabi',
      'x86': 'i686-linux-android',
      'x86_64': 'x86_64-linux-android',
    })) {
      mkdirSync(path.join(jni, abi), { recursive: true });
      execFileSync(path.join(bin, 'clang'), [`--target=${target}23`, '-shared', '-fPIC', '-g', '-Wl,--build-id=sha1', source, '-o', path.join(jni, abi, 'libfixture.so')]);
    }
    assert.throws(() => stripAndroid(jni, path.join(jni, 'debug'), bin), /outside/);
    const result = stripAndroid(jni, symbols, bin);
    assert.equal(result.count, 4);
    assert.ok(result.after < result.before);
    for (const abi of readdirSync(jni)) {
      const sections = execFileSync(path.join(bin, 'llvm-readelf'), ['--sections', path.join(jni, abi, 'libfixture.so')], { encoding: 'utf8' });
      assert.doesNotMatch(sections, /\.debug_info|\.symtab/);
      assert.ok(statSync(path.join(symbols, abi, 'libfixture.so.debug')).size > 0);
    }
    assert.throws(() => stripAndroid(jni, symbols, bin), /overwrite/);
    const empty = path.join(root, 'empty');
    mkdirSync(empty);
    assert.throws(() => stripAndroid(empty, symbols, bin), /No Android/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
