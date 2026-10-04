import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const scripts = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
function fixture(fn) {
  const root = mkdtempSync(path.join(tmpdir(),'wfloat-stage-test-'));
  const pkg = path.join(root,'packages/react-native-wfloat');
  const put = (file,text='fixture') => { mkdirSync(path.dirname(file),{recursive:true}); writeFileSync(file,text); };
  put(path.join(pkg,'scripts/stage-natives.sh'),readFileSync(path.join(scripts,'stage-natives.sh')));
  const staged = path.join(pkg,'android/src/main/jniLibs/arm64-v8a');
  const speech = path.join(root,'vendor/sherpa-onnx/build-android-arm64-v8a/install/lib');
  for(const name of ['libsherpa-onnx-c-api.so','libonnxruntime.so']) {
    put(path.join(speech,name),'new speech'); put(path.join(staged,name),'old speech');
  }
  put(path.join(staged,'libwfloat-llm-jni.so'),'old legacy');
  put(path.join(staged,'libwfloat-next-jni.so'),'old next');
  const run=(args,abis='arm64-v8a')=>spawnSync('bash',[path.join(pkg,'scripts/stage-natives.sh'),...args],{encoding:'utf8',env:{...process.env,WFLOAT_ANDROID_ABIS:abis}});
  try { fn({root,pkg,put,staged,speech,run}); } finally { rmSync(root,{recursive:true,force:true}); }
}
test('speech bootstrap preserves both staged bridges',()=>fixture(({staged,run})=>{
  const r=run(['android','--speech-only']); assert.equal(r.status,0,r.stderr);
  assert.equal(readFileSync(path.join(staged,'libwfloat-next-jni.so'),'utf8'),'old next');
  assert.equal(readFileSync(path.join(staged,'libwfloat-llm-jni.so'),'utf8'),'old legacy');
  assert.equal(readFileSync(path.join(staged,'libonnxruntime.so'),'utf8'),'new speech');
}));
test('full staging rejects a missing next artifact before changing dependencies',()=>fixture(({root,put,staged,run})=>{
  put(path.join(root,'out/rn-llm-android-arm64-v8a/libwfloat-llm-jni.so'),'new legacy');
  const r=run(['android']); assert.notEqual(r.status,0); assert.match(r.stderr,/Missing Android bridge/);
  assert.equal(readFileSync(path.join(staged,'libonnxruntime.so'),'utf8'),'old speech');
}));
test('full staging copies both bridge outputs with matching speech libraries',()=>fixture(({root,pkg,put,staged,run})=>{
  put(path.join(root,'out/rn-llm-android-arm64-v8a/libwfloat-llm-jni.so'),'new legacy');
  put(path.join(pkg,'android/build/next-native/arm64-v8a/libwfloat-next-jni.so'),'new next');
  const r=run(['android']); assert.equal(r.status,0,r.stderr);
  assert.equal(readFileSync(path.join(staged,'libwfloat-next-jni.so'),'utf8'),'new next');
  assert.equal(readFileSync(path.join(staged,'libwfloat-llm-jni.so'),'utf8'),'new legacy');
}));
test('later missing ABI cannot partially replace speech dependencies',()=>fixture(({root,pkg,put,staged,run})=>{
  for(const abi of ['arm64-v8a','x86']) {
    put(path.join(root,`out/rn-llm-android-${abi}/libwfloat-llm-jni.so`));
    put(path.join(pkg,`android/build/next-native/${abi}/libwfloat-next-jni.so`));
  }
  const r=run(['android'],'arm64-v8a,x86'); assert.notEqual(r.status,0);
  assert.equal(readFileSync(path.join(staged,'libonnxruntime.so'),'utf8'),'old speech');
}));
test('iOS staging rejects a legacy-only framework even if the old output exists',()=>fixture(({root,pkg,put,run})=>{
  for(const folder of ['vendor/sherpa-onnx/build-ios/sherpa-onnx.xcframework','vendor/sherpa-onnx/build-ios/ios-onnxruntime/onnxruntime.xcframework','out/rn-llm-ios/wfloat-core-llm.xcframework']) mkdirSync(path.join(root,folder),{recursive:true});
  mkdirSync(path.join(pkg,'ios/build/next-runtime/wfloat-core-llm.xcframework'),{recursive:true});
  put(path.join(pkg,'ios/wfloat-core-llm.xcframework/sentinel'),'keep');
  const r=run(['ios']); assert.notEqual(r.status,0); assert.match(r.stderr,/Missing combined runtime public header/);
  assert.equal(readFileSync(path.join(pkg,'ios/wfloat-core-llm.xcframework/sentinel'),'utf8'),'keep');
}));
test('iOS staging selects combined output and never the obsolete legacy archive',()=>fixture(({root,pkg,put,run})=>{
  for(const folder of ['vendor/sherpa-onnx/build-ios/sherpa-onnx.xcframework','vendor/sherpa-onnx/build-ios/ios-onnxruntime/onnxruntime.xcframework']) mkdirSync(path.join(root,folder),{recursive:true});
  put(path.join(root,'out/rn-llm-ios/wfloat-core-llm.xcframework/marker'),'obsolete');
  const combined=path.join(pkg,'ios/build/next-runtime/wfloat-core-llm.xcframework');
  put(path.join(combined,'marker'),'combined');
  for(const slice of ['ios-arm64','ios-arm64_x86_64-simulator']) put(path.join(combined,`${slice}/Headers/wfloat-next/NextRuntime.h`));
  const r=run(['ios']); assert.equal(r.status,0,r.stderr);
  assert.equal(readFileSync(path.join(pkg,'ios/wfloat-core-llm.xcframework/marker'),'utf8'),'combined');
}));
