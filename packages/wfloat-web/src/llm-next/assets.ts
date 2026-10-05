import { MODEL_ASSETS, REGISTRY_ORIGIN } from '../worker/generatedModelUrls.js';

type FileAsset = { path: string; sha256: string; sizeBytes: number };
/** Select inference weights explicitly: notices and terms are not GGUF files. */
export function languageModelFiles(record: Record<string, unknown>): Array<{ name: string; url: string }> {
  const shardKeys = Object.keys(record).filter(key => key.startsWith('model_shard_')).sort();
  const file = (key: string): FileAsset => {
    const value = record[key] as FileAsset | undefined;
    if (!value || typeof value.path !== 'string' || !value.path.endsWith('.gguf')) throw new Error(`Missing GGUF asset: ${key}`);
    return value;
  };
  if (!shardKeys.length) return [{ name: 'model.gguf', url: new URL(file('model').path, REGISTRY_ORIGIN).href }];
  if (record.model || shardKeys.length < 2) throw new Error('Invalid GGUF shard manifest.');
  return shardKeys.map((key, index) => {
    if (key !== `model_shard_${String(index + 1).padStart(5, '0')}`) throw new Error('GGUF shard roles must be contiguous, starting at 00001.');
    return { name: `model-${String(index + 1).padStart(5, '0')}-of-${String(shardKeys.length).padStart(5, '0')}.gguf`, url: new URL(file(key).path, REGISTRY_ORIGIN).href };
  });
}
export function getLanguageModelFiles(id: string): ReturnType<typeof languageModelFiles> {
  if (!Object.prototype.hasOwnProperty.call(MODEL_ASSETS, id)) throw new Error(`Unknown model: ${id}`);
  return languageModelFiles(MODEL_ASSETS[id as keyof typeof MODEL_ASSETS]);
}
