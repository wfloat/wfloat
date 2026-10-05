import { MODEL_ASSETS, REGISTRY_ORIGIN, SHARED_ASSETS } from "../worker/generatedModelUrls.js";
import { isComposite, compositeParts } from "./composite.js";
import type { AssetManifestEntry } from "./types.js";

export type AssetModelId = keyof typeof MODEL_ASSETS;
export type RuntimeFamily = "speech" | "llama";
type RegistryAsset = { path: string; sha256: string; sizeBytes?: number };
const runtimeAssets = new Map<RuntimeFamily, readonly AssetManifestEntry[]>();

/** Build/loader integration: configure the exact WASM (and optional .data) URLs
 * used by the runtime before downloadModel. Runtime files are shared dependencies.
 * Versioned release URLs may lack hashes; CI URLs contain their SHA-256. */
export function configureRuntimeAssets(family: RuntimeFamily, assets: readonly Omit<AssetManifestEntry, "shared">[]): void {
  if (!assets.length) throw new Error(`Missing ${family} runtime assets`);
  runtimeAssets.set(family, assets.map(asset => {
    const url = new URL(asset.url).href;
    if (asset.sizeBytes !== undefined && (!Number.isSafeInteger(asset.sizeBytes) || asset.sizeBytes < 0))
      throw new Error("Runtime asset sizeBytes must be a nonnegative safe integer");
    if (asset.sha256 !== undefined && !/^[a-f0-9]{64}$/.test(asset.sha256))
      throw new Error("Runtime asset sha256 must be a lowercase SHA-256 hex digest");
    const embeddedHash = /-([a-f0-9]{64})\.wasm(?:\?|$)/.exec(url)?.[1];
    return { ...asset, url, sha256: asset.sha256 ?? embeddedHash, shared: true };
  }));
}
export function getModelRuntimeFamily(id: string): RuntimeFamily {
  if (!Object.prototype.hasOwnProperty.call(MODEL_ASSETS, id)) throw new Error(`Unknown model: ${id}`);
  const record = MODEL_ASSETS[id as AssetModelId];
  const family = 'family' in record ? record.family : undefined;
  return ["smollm", "gemma3", "qwen3"].includes(family ?? "") ? "llama" : "speech";
}
function entry(asset: RegistryAsset, shared: boolean): AssetManifestEntry {
  return { url: new URL(asset.path, REGISTRY_ORIGIN).href, sha256: asset.sha256,
    sizeBytes: asset.sizeBytes, shared };
}
/** Registry files only; useful for deletion and runtime integration. */
export function getModelAssetManifest(id: string): readonly AssetManifestEntry[] {
  getModelRuntimeFamily(id);
  const records = MODEL_ASSETS[id as AssetModelId];
  const assets: AssetManifestEntry[] = [];
  for (const value of Object.values(records)) {
    if (isComposite(value)) assets.push(...compositeParts(value).map(part => entry(part, false)));
    else if (typeof value === "object" && "path" in value) assets.push(entry(value, false));
  }
  if (id === "wfloat/wfloat-tts" || ("family" in records && ["piper", "kokoro", "kitten"].includes(records.family))) assets.push(entry(SHARED_ASSETS.espeak_ng_data_zip, true));
  return assets;
}
/** Includes required runtime dependencies; fail rather than claim an incomplete predownload. */
export function getModelDownloadManifest(id: string): readonly AssetManifestEntry[] {
  const family = getModelRuntimeFamily(id);
  const runtime = runtimeAssets.get(family);
  if (!runtime) throw new Error(`Configure ${family} runtime assets before downloading ${id}`);
  return [...getModelAssetManifest(id), ...runtime];
}
