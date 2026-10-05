import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Preserve dynamic exports and unwind information; remove only symbols/debug
// sections unnecessary to load the shared library. Keep separate debug files.
export function stripAndroid(jniDir, symbolsDir, binDir) {
  jniDir = path.resolve(jniDir);
  symbolsDir = path.resolve(symbolsDir);
  if (symbolsDir === jniDir || symbolsDir.startsWith(jniDir + path.sep)) {
    throw new Error('Debug symbols must be stored outside the packaged JNI directory.');
  }
  const run = (tool, args) => execFileSync(path.join(binDir, tool), args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  let before = 0, after = 0, count = 0;
  for (const abi of readdirSync(jniDir).filter(x => !x.startsWith('.'))) {
    for (const name of readdirSync(path.join(jniDir, abi)).filter(x => x.endsWith('.so'))) {
      const file = path.join(jniDir, abi, name);
      const symbols = path.join(symbolsDir, abi, name + '.debug');
      if (existsSync(symbols)) throw new Error(`Refusing to overwrite debug symbols: ${symbols}`);
      const exports = run('llvm-nm', ['--dynamic', '--defined-only', file]);
      const dynamic = run('llvm-readelf', ['--dynamic', file]);
      const notes = run('llvm-readelf', ['--notes', file]);
      before += statSync(file).size;
      mkdirSync(path.dirname(symbols), { recursive: true });
      run('llvm-objcopy', ['--only-keep-debug', file, symbols]);
      run('llvm-strip', ['--strip-unneeded', file]);
      if (exports !== run('llvm-nm', ['--dynamic', '--defined-only', file]) ||
          dynamic !== run('llvm-readelf', ['--dynamic', file]) ||
          notes !== run('llvm-readelf', ['--notes', file])) {
        throw new Error(`Stripping changed runtime symbols, dynamic metadata, or build ID: ${file}`);
      }
      after += statSync(file).size;
      count++;
    }
  }
  if (!count) throw new Error('No Android shared libraries found.');
  console.log(`Stripped ${count} libraries: ${before} -> ${after} bytes. Debug symbols: ${symbolsDir}`);
  return { count, before, after };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [jniDir, symbolsDir] = process.argv.slice(2);
  const ndk = process.env.ANDROID_NDK_HOME;
  if (!jniDir || !symbolsDir || !ndk) throw new Error('Usage: ANDROID_NDK_HOME=... node strip-android-symbols.mjs <jni-dir> <external-symbols-dir>');
  const prebuilt = path.join(ndk, 'toolchains/llvm/prebuilt');
  const hosts = readdirSync(prebuilt).filter(x => existsSync(path.join(prebuilt, x, 'bin/llvm-strip')));
  if (hosts.length !== 1) throw new Error('Expected one NDK host toolchain.');
  stripAndroid(jniDir, symbolsDir, path.join(prebuilt, hosts[0], 'bin'));
}
