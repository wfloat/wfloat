#!/usr/bin/env node
// Publisher preflight. Does not build, download, install, or publish anything.
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const abis = ['arm64-v8a', 'armeabi-v7a', 'x86_64', 'x86'];
const slices = ['ios-arm64', 'ios-arm64_x86_64-simulator'];
export function nativeFiles() {
  const files = [];
  for (const abi of abis) {
    for (const name of ['libonnxruntime.so', 'libsherpa-onnx-c-api.so', 'libsherpa-onnx-cxx-api.so', 'libsherpa-onnx-jni.so', 'libwfloat-llm-jni.so', 'libwfloat-next-jni.so']) {
      files.push(`android/src/main/jniLibs/${abi}/${name}`);
    }
  }
  for (const framework of ['sherpa-onnx', 'onnxruntime', 'wfloat-core-llm']) {
    files.push(`ios/${framework}.xcframework/Info.plist`);
    for (const slice of slices) {
      files.push(`ios/${framework}.xcframework/${slice}/lib${framework}.a`);
    }
  }
  for (const slice of slices) {
    files.push(`ios/wfloat-core-llm.xcframework/${slice}/Headers/wfloat-next/NextRuntime.h`);
    files.push(`ios/wfloat-core-llm.xcframework/${slice}/Headers/wfloat-core/wfloat_llm.h`);
  }
  return files;
}
export function auditPack(paths) {
  const files = new Set(paths);
  const errors = [];
  for (const file of [
    ...nativeFiles(), 'package.json', 'react-native-wfloat.podspec', 'react-native.config.js',
    'src/NativeWfloat.ts', 'src/NativeWfloatNext.ts', 'src/index.tsx',
    'lib/module/index.js', 'lib/commonjs/index.js',
    'lib/typescript/module/src/index.d.ts', 'lib/typescript/commonjs/src/index.d.ts',
    'android/generated/java/com/wfloat/NativeWfloatSpec.java',
    'android/generated/java/com/wfloat/NativeWfloatNextSpec.java',
    'android/generated/jni/CMakeLists.txt',
    'README.md', 'LEGACY_API.md', 'CONTRIBUTING.md',
    'android/AndroidManifest.background.example.xml',
    'scripts/NATIVE-BUILD.md', 'scripts/THIRD-PARTY-NOTICES.txt',
  ]) if (!files.has(file)) errors.push(`Missing packed file: ${file}`);
  for (const file of files) {
    if (/^(cpp|example|test-apps)\//.test(file) ||
        /^(android|ios)\/(build[^/]*|tests|next-jni|llm-jni)\//.test(file) ||
        /(^|\/)(__tests__|__fixtures__|__mocks__|node_modules|Pods|DerivedData|\.[^/]+)(\/|$)/.test(file) ||
        /^(android|ios)\/.*\.md$/i.test(file) || /\.(log|tgz)$/.test(file)) {
      errors.push(`Private/build/test file in tarball: ${file}`);
    }
  }
  return errors;
}
function main() {
  const args = process.argv.slice(2);
  if (args.some(arg => arg !== '--pack')) throw new Error('Usage: node scripts/verify-native-package.mjs [--pack]');
  const errors = [];
  // Reject symlinked distribution artifacts: npm does not dereference these.
  for (const file of nativeFiles()) {
    const absolute = path.join(packageDir, file);
    if (!existsSync(absolute) || lstatSync(absolute).size === 0) { errors.push(`Missing/empty native artifact: ${file}`); continue; }
    let current = absolute;
    while (current !== packageDir) {
      if (lstatSync(current).isSymbolicLink()) { errors.push(`Native artifact is a symlink: ${path.relative(packageDir,current)}`); break; }
      current = path.dirname(current);
    }
  }
  for (const abi of readdirSync(path.join(packageDir, 'android/src/main/jniLibs'))) {
    if (!abis.includes(abi) && !abi.startsWith('.')) errors.push(`Unexpected packaged Android ABI directory: ${abi}`);
  }
  if (args.includes('--pack')) {
    // npm 10's bundled pacote runs prepare even with --ignore-scripts.
    // This is an artifact snapshot, so explicitly disable its lifecycle shell.
    // Publisher builds run separately; missing outputs still fail the audit.
    const result = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts', '--foreground-scripts=false', '--script-shell=/usr/bin/true'], {
      cwd: packageDir, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
    }));
    if (result.length !== 1 || !Array.isArray(result[0].files)) throw new Error('Invalid npm pack manifest.');
    errors.push(...auditPack(result[0].files.map(file => file.path)));
    console.log(`Audited ${result[0].files.length} packed files (${result[0].unpackedSize} bytes unpacked).`);
  }
  if (errors.length) throw new Error([...new Set(errors)].join('\n'));
  console.log('Native package preflight passed for four Android ABIs and both iOS slices (legacy + next).');
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
