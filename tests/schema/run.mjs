// SPDX-License-Identifier: MIT
// No installs/build engines. Uses the existing compiler and TypeScript.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const scratch = mkdtempSync(join(tmpdir(), 'wfloat-schema-'));
function command(exe, args, options = {}) {
  const r = spawnSync(exe, args, { encoding: 'utf8', ...options });
  assert.equal(r.status, 0, `${exe}: ${r.error ?? ''}\n${r.stderr}\n${r.stdout}`);
  return r.stdout;
}
try {
  const binary = join(scratch, 'validator');
  command(process.env.CXX || 'clang++', ['-std=c++17', '-Wall', '-Wextra', '-Werror', '-I', join(root, 'vendor/llama.cpp/vendor'), '-I', join(root, 'native/wfloat-core/src/schema'), join(root, 'native/wfloat-core/src/schema/validator.cc'), join(root, 'tests/schema/native_driver.cc'), '-o', binary]);
  const native = {
    checkSchema: schema => JSON.parse(command(binary, [], { input: JSON.stringify({schema}) + '\n' })),
    validate: (schema, value) => JSON.parse(command(binary, [], { input: JSON.stringify({schema,value}) + '\n' })),
  };
  const fixtures = JSON.parse(readFileSync(join(root, 'tests/schema/cases.json'), 'utf8'));
  const answers = command(binary, [], { input: fixtures.map(f => JSON.stringify(f)).join('\n') + '\n' }).trim().split('\n').map(s => JSON.parse(s));
  fixtures.forEach((f, n) => {
    assert.equal(answers[n].valid, f.valid, f.name);
    if (!f.valid) for (const key of ['code','instancePath','schemaPath']) if (key in f) assert.equal(answers[n].issues[0][key], f[key], f.name);
  });
  // Preserve exact native integer tokens beyond JS number precision.
  const large = JSON.parse(command(binary, [], { input: '{"schema":{"maximum":9007199254740992.0},"value":9007199254740993}\n' }));
  assert.equal(large.valid, false);
  const tsc = join(root, 'packages/wfloat-web/node_modules/.bin/tsc');
  const flags = ['--strict','--skipLibCheck','--target','ES2020','--module','nodenext','--moduleResolution','nodenext'];
  command(tsc, [...flags, '--noEmit', join(root,'tests/schema/types.test.ts')]);
  command(tsc, [...flags, '--outDir', join(scratch,'js'), join(root,'packages/wfloat-web/src/schema/index.ts')]);
  writeFileSync(join(scratch,'js/package.json'), '{"type":"module"}');
  const { prepareSchema, prepareSchemaAsync, SchemaConfigurationError, SchemaValidationError, SchemaValidationAbortedError } = await import(pathToFileURL(join(scratch,'js/index.js')));
  for (const f of fixtures) {
    if (f.code === 'invalidSchema' || f.code === 'unsupportedSchema') {
      assert.throws(() => prepareSchema(f.schema, native), SchemaConfigurationError, f.name);
    } else {
      const prepared = prepareSchema(f.schema, native);
      if ('value' in f) assert.equal((await prepared.validate(f.value)).success, f.valid, `JS/native ${f.name}`);
    }
  }
  const worker = { checkSchema: async schema => native.checkSchema(schema), validateSchema: async (schema,value) => native.validate(schema,value) };
  const asyncPrepared = await prepareSchemaAsync({type:'integer'},worker);
  assert.equal(await asyncPrepared.parse(3),3);
  await assert.rejects(asyncPrepared.parse('3'),SchemaValidationError);
  await assert.rejects(prepareSchemaAsync({pattern:'.*'},worker),SchemaConfigurationError);
  let releaseCheck;
  let preparedEarly = false;
  const delayed = prepareSchemaAsync(true,{...worker,checkSchema:()=>new Promise(resolve=>{releaseCheck=resolve;})}).then(value=>{preparedEarly=true;return value;});
  await Promise.resolve(); assert.equal(preparedEarly,false);
  releaseCheck({valid:true,issues:[]}); await delayed; assert.equal(preparedEarly,true);
  const preflightAbort = new AbortController();
  const neverChecked = prepareSchemaAsync(true,{...worker,checkSchema:()=>new Promise(()=>{})},{signal:preflightAbort.signal});
  preflightAbort.abort(); await assert.rejects(neverChecked,SchemaValidationAbortedError);
  await assert.rejects(prepareSchemaAsync(true,{...worker,checkSchema:async()=>{throw Error('worker unavailable');}}),/worker unavailable/);
  for (const f of fixtures.filter(f=>'value' in f && !f.code)) {
    const p = await prepareSchemaAsync(f.schema,worker);
    assert.equal((await p.validate(f.value)).success,f.valid,`async JS/native ${f.name}`);
  }
  assert.equal(native.checkSchema({enum:Array.from({length:500},(_,i)=>i)}).issues[0].code,'unsupportedSchema');
  assert.equal(native.validate({uniqueItems:true},Array.from({length:500},(_,i)=>i)).issues[0].code,'resourceLimit');
  let deep = {}; for(let i=0;i<140;i++) deep={properties:{x:deep}};
  assert.equal(native.checkSchema(deep).valid,false);
  assert.throws(() => prepareSchema({}, undefined), SchemaConfigurationError);
  assert.throws(() => prepareSchema({type:'string', pattern:undefined}, native), SchemaConfigurationError);
  assert.throws(() => prepareSchema({ get type() { throw Error('must not run'); } }, native), /enumerable string data/);
  const cycle = {}; cycle.self = cycle;
  assert.throws(() => prepareSchema(cycle,native), SchemaConfigurationError);
  const mutable = {type:'number'};
  const prepared = prepareSchema(mutable,native); mutable.type = 'string';
  assert.equal((await prepared.validate(1)).success,true);
  assert.equal((await prepared.validate('1')).success,false);
  assert.ok(Object.isFrozen(prepared.jsonSchema));
  for (const value of ['\ud800', '\udfff', {['\ud800']:1}, undefined, NaN, Infinity, new Date(), new Map(), ()=>1, 1n, cycle, [,1], [undefined]]) assert.equal((await prepareSchema(true,native).validate(value)).success,false);
  const pollution = JSON.parse('{"__proto__":{"polluted":true}}');
  const clean = await prepareSchema(true,native).validate(pollution);
  assert.equal(clean.success,true); assert.equal({}.polluted,undefined); assert.ok(Object.hasOwn(clean.value,'__proto__'));
  assert.throws(() => prepareSchema({}, {...native,checkSchema:()=>({valid:true})}), /Invalid native/);
  await assert.rejects(prepareSchema({}, {...native,validate:()=>({valid:true,issues:[{}]})}).validate(1), /Invalid native/);
  await assert.rejects(prepareSchema({}, {...native,validate:()=>{throw Error('bridge broken');}}).validate(1), /bridge broken/);
  const controller = new AbortController();
  let rejectLate;
  const pending = prepareSchema({}, {...native,validate:()=>new Promise((_,reject)=>{rejectLate=reject;})}).validate(1,{signal:controller.signal});
  controller.abort(); await assert.rejects(pending, SchemaValidationAbortedError); rejectLate(Error('late'));
  let called = false;
  await assert.rejects(prepareSchema({}, {...native,validate:()=>{called=true;return {valid:true,issues:[]};}}).validate(1,{signal:controller.signal}),SchemaValidationAbortedError);
  assert.equal(called,false);
  const unsupportedParser = { safeParseAsync: async () => ({success:true,data:1}), '~standard': {vendor:'zod',version:1} };
  assert.throws(()=>prepareSchema(unsupportedParser,native), /no accepted-input/);
  const zodPath = process.env.WFLOAT_TEST_ZOD_PATH || resolve(root,'../assets/wfloat-logo-lab/node_modules/zod');
  if (existsSync(join(zodPath,'package.json'))) {
    const z = await import(pathToFileURL(join(zodPath,'index.js')));
    const zodVersion = JSON.parse(readFileSync(join(zodPath,'package.json'),'utf8')).version;
    const schema = z.object({quantity:z.string().transform(Number),note:z.string().optional(),defaulted:z.string().default('yes')});
    const converted = prepareSchema(schema,native);
    assert.equal(converted.jsonSchema.properties.quantity.type,'string');
    assert.ok(!converted.jsonSchema.required.includes('defaulted'));
    const raw = {quantity:'3'};
    const parsed = await converted.validate(raw);
    assert.equal(parsed.success,true); assert.equal(parsed.value.quantity,3); assert.equal(parsed.value.defaulted,'yes');
    assert.deepEqual(await converted.parse({quantity:'4'}),{quantity:4,defaulted:'yes'});
    assert.equal(raw.quantity,'3'); assert.equal(raw.defaulted,undefined);
    assert.equal((await converted.validate({quantity:3})).success,false);
    const nullable = prepareSchema(z.string().nullable(),native);
    assert.equal((await nullable.validate(null)).success,true);
    const refined = prepareSchema(z.string().refine(async x=>x==='yes'),native);
    assert.equal((await refined.validate('no')).success,false);
    assert.equal((await refined.validate('yes')).success,true);
    let transforms = 0;
    const asyncTransform = prepareSchema(z.string().transform(async s=>{transforms++;return s.length;}),native);
    assert.deepEqual(await asyncTransform.validate('abc'),{success:true,value:3}); assert.equal(transforms,1);
    const broken = prepareSchema(z.string().transform(()=>{throw Error('developer bug');}),native);
    await assert.rejects(broken.validate('x'),/developer bug/);
    await assert.rejects(broken.parse('x'),error=>!(error instanceof SchemaValidationError)&&error.message==='developer bug');
    assert.throws(()=>prepareSchema(z.string().email(),native),SchemaConfigurationError);
    const standardOnly = z.string().transform(s=>s.length);
    standardOnly.toJSONSchema = undefined;
    assert.deepEqual(await prepareSchema(standardOnly,native).validate('abc'),{success:true,value:3});
    const neverEnds = prepareSchema(z.string().transform(()=>new Promise(()=>{})),native);
    const zAbort = new AbortController();
    const zPending = neverEnds.validate('x',{signal:zAbort.signal}); zAbort.abort();
    await assert.rejects(zPending,SchemaValidationAbortedError);
    const typeFile = join(scratch,'zod-types.mts');
    writeFileSync(typeFile, `import {z} from ${JSON.stringify(join(zodPath,'index.js'))};
import {prepareSchema} from ${JSON.stringify(join(root,'packages/wfloat-web/src/schema/adapter.js'))};
import type {InferSchema,InferSchemaInput,NativeSchemaValidator,SchemaInput} from ${JSON.stringify(join(root,'packages/wfloat-web/src/schema/types.js'))};
const s=z.object({quantity:z.string().transform(Number)});
const accepts: SchemaInput=s;
const output: InferSchema<typeof s>={quantity:3};
const input: InferSchemaInput<typeof s>={quantity:'3'};
// @ts-expect-error parsed output is numeric
const wrong: InferSchema<typeof s>={quantity:'3'};
declare const native: NativeSchemaValidator;
prepareSchema(s,native).validate({quantity:'3'}).then(r=>{if(r.success){const n:number=r.value.quantity;}});
`);
    command(tsc,[...flags,'--noEmit',typeFile]);
    console.log(`Zod ${zodVersion}: conversion, defaults, refinements, transforms, cancellation and real type inference passed`);
  } else {
    console.log('Zod compatibility tests skipped: set WFLOAT_TEST_ZOD_PATH to an existing installation');
  }
  await new Promise(resolve=>setTimeout(resolve,0)); // let late rejection observers run
  console.log(`${fixtures.length} native + JS/native fixtures passed; adapter and TS checks passed`);
} finally { rmSync(scratch,{recursive:true,force:true}); }
