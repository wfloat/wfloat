import { loadLanguageModel } from '@wfloat/react-native-wfloat';
import { loadAssets, modelManifest } from '../../src/next/assets';
import { NativeInstance } from '../../src/next/llm-native/instance';
import { request } from '../../src/next/platform/bridge';

/** Explicit development-only fixture, using the published registry and opaque native cache. */
export async function gemmaSmoke(log: (message: string) => void) {
  const id = 'google/gemma-3-1b-it';
  const manifest = modelManifest(id);
  if (manifest.task !== 'llm' || manifest.family !== 'gemma3' || manifest.assets.length !== 6) throw new Error('Gemma manifest mismatch');
  let progressBucket = '';
  const lease = await loadAssets(id, 'llm', { onProgress: e => {
    const bucket = e.phase === 'downloading' ? `${e.phase}:${Math.floor((e.progress ?? 0) * 10)}` : e.phase;
    if (bucket !== progressBucket) { progressBucket = bucket; log(`Gemma assets ${JSON.stringify(e)}`); }
  } });
  try {
    for (const [name, paths] of [
      ['missing-first', { model_shard_00002: lease.paths.model_shard_00002 }],
      ['missing-last', { model_shard_00001: lease.paths.model_shard_00001 }],
      ['gap', { ...lease.paths, model_shard_00004: lease.paths.model_shard_00002 }],
      ['absent-file', { ...lease.paths, model_shard_00002: lease.paths.model_shard_00002 + '.missing' }],
    ] as const) {
      const instance = new NativeInstance();
      let error: unknown;
      try { await instance.call('load', { task: 'llm', paths }); }
      catch (caught) { error = caught; }
      finally { await instance.unload().catch(error => { if (!String(error).includes('Unknown instanceId')) throw error; }); }
      if (!error) throw new Error(`${name} unexpectedly loaded`);
      log(`Gemma ${name} rejected: ${String(error)}`);
    }
    // Abort after native dispatch, exercising cancellation cleanup and pin release.
    const abort = new AbortController();
    const instance = new NativeInstance();
    const pending = instance.call('load', { task: 'llm', paths: lease.paths }, { signal: abort.signal });
    const timer = setTimeout(() => abort.abort(), 10);
    let rejected = false;
    try { await pending; } catch { rejected = abort.signal.aborted; }
    finally { clearTimeout(timer); await instance.unload().catch(error => { if (!String(error).includes('Unknown instanceId')) throw error; }); }
    if (!rejected) throw new Error('Gemma load cancellation did not reject');
    log('Gemma native-dispatch load cancellation verified');
  } finally { lease.release(); }
  const phases: string[] = [];
  for (let pass = 0; pass < 2; pass++) {
    const model = await loadLanguageModel(id, { onProgress: e => phases.push(e.phase) });
    try {
      if (model.contextSize !== 2048) throw new Error('Default context changed');
      const result = await model.generate([{ role: 'user', content: 'Say hello in one short sentence.' }], { temperature: 0, maxTokensPerRound: 24 }).result();
      if (!result.text.trim() || !result.usage.outputTokens) throw new Error('Empty Gemma generation');
      log(`Gemma pass ${pass}: ${JSON.stringify(result)}`);
      const generation = model.generate([{ role: 'user', content: 'Count from one to one hundred.' }], { maxTokensPerRound: 128, onText: () => generation.cancel() });
      if ((await generation.result()).stopReason !== 'cancelled') throw new Error('Generation cancellation failed');
      // Deleting one loaded split must hide its cache entry but retain the pinned file.
      if (pass === 1) {
        const shard = manifest.assets.find(a => a.name === 'model_shard_00002')!;
        await request({ op: 'assetDelete', key: shard.key });
        if (await request({ op: 'assetStat', key: shard.key }) !== null) throw new Error('Deleted shard still discoverable');
        const afterDelete = await model.generate([{ role: 'user', content: 'Say goodbye.' }], { maxTokensPerRound: 16 }).result();
        if (!afterDelete.text.trim()) throw new Error('Pinned shard generation failed');
      }
    } finally { await model.unload(); await model.unload(); }
  }
  if (phases.includes('downloading')) throw new Error('Cached reload unexpectedly downloaded');
  log('Gemma PASS: verified registry assets, missing shards, load/generation cancel, default context, cached reload, pinned deletion, unload');
  return { modelId: id, contextSize: 2048, assets: manifest.assets.map(a => a.name), cachedGenerations: 2, loadCancellation: true, generationCancellation: true, pinnedDeletion: true };
}

/** Supplemental native download + SDK cache/load probe. Query URLs are test-only;
 * this does not validate cold canonical-URL availability at the CDN edge. */
export async function gemmaPublicProbe(log: (message: string) => void) {
  for (const asset of modelManifest('google/gemma-3-1b-it').assets) {
    log(`Gemma supplemental public hash probe ${asset.name}`);
    await request({ op: 'assetDownload', ...asset, url: `${asset.url}?sha256=${asset.sha256}&rn_probe=${Date.now()}` });
  }
  return gemmaSmoke(log);
}
