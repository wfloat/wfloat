import { downloadModel, loadTextToSpeech, type SpeechResult } from '@wfloat/react-native-wfloat';
import { KITTEN_VOICES, KITTEN_EXPORT_VOICES, standardConfig, standardModel, standardVoice } from '../../src/next/tts-next/families';
import { modelManifest } from '../../src/next/assets';

export const KITTEN_ROLLOUT_MODELS = ['KittenML/kitten-tts-nano-0.8', 'KittenML/kitten-tts-mini-0.8'] as const;
const EXPECTED_NAMES = ['Jasper', 'Bella', 'Bruno', 'Luna', 'Hugo', 'Rosie', 'Leo', 'Kiki'];
const EXPECTED_ALIASES = ['expr-voice-2-m', 'expr-voice-2-f', 'expr-voice-3-m', 'expr-voice-3-f', 'expr-voice-4-m', 'expr-voice-4-f', 'expr-voice-5-m', 'expr-voice-5-f'];
const RAW_TEXT = "  Dr. Smith paid $12.50. Don't rush!  ";
type Model = Awaited<ReturnType<typeof loadTextToSpeech>>;
function audioStats(result: SpeechResult, text: string) {
  const { samples, sampleRate } = result.audio;
  if (sampleRate !== 24000 || !samples.length) throw new Error('Kitten must return nonempty 24kHz audio');
  let peak = 0, power = 0;
  for (const sample of samples) {
    if (!Number.isFinite(sample)) throw new Error('Kitten returned non-finite PCM');
    peak = Math.max(peak, Math.abs(sample)); power += sample * sample;
  }
  if (peak <= 0.001) throw new Error('Kitten returned effectively silent PCM');
  const seconds = samples.length / sampleRate;
  if (seconds > 60) throw new Error('Unexpectedly long audio for a short Kitten fixture');
  // The shared frontend chunks internally. RN must retain one raw UTF-16 unit.
  if (result.timeline.length !== 1 || result.timeline[0]!.textStart !== 0 ||
      result.timeline[0]!.textEnd !== text.length || result.timeline[0]!.text !== text)
    throw new Error('Kitten original-text timeline mismatch');
  return { sampleRate, samples: samples.length, seconds, peak, rms: Math.sqrt(power / samples.length) };
}
async function synthesize(model: Model, text: string, voiceId?: string | number) {
  const start = Date.now();
  const generation = model.generate(text, voiceId === undefined ? {} : { voiceId });
  try { return { ...audioStats(await generation.result(), text), inferenceMs: Date.now() - start }; }
  finally { generation.dispose(); }
}
let active = false;
/** Parent-invoked fixture; requires final Kitten 0.8 engines and registry.
 * Serialize against other fixtures. Generates 18 short results per model without
 * playback: default + eight names, then cached reload + eight aliases + Hugo ID.
 * Integration owner may import { kittenRolloutSmoke } from './KittenRolloutSmoke'. */
export async function kittenRolloutSmoke(log: (message: string) => void) {
  if (active) throw new Error('Kitten fixture is already running');
  active = true;
  try {
    if (JSON.stringify(KITTEN_VOICES) !== JSON.stringify(EXPECTED_NAMES) ||
        JSON.stringify(KITTEN_EXPORT_VOICES) !== JSON.stringify(EXPECTED_ALIASES)) throw new Error('Kitten artifact voice order changed');
    const results = [];
    for (const modelId of KITTEN_ROLLOUT_MODELS) {
      const config = standardConfig(modelId), manifest = modelManifest(modelId);
      const quant = modelId.includes('nano') ? 'int8' : 'int8-fp16';
      const modelAsset = manifest.assets.find(a => a.name === 'model_onnx');
      if (standardModel(modelId)?.quant !== quant || !modelAsset?.url?.includes(`/${quant}/`)) throw new Error('Kitten fixture requires the pinned registry model');
      for (const role of ['model_tokens', 'model_voices']) if (!manifest.assets.some(a => a.name === role)) throw new Error(`Kitten ${role} missing`);
      if (!manifest.assets.some(a => a.name === 'espeak_data' && a.shared)) throw new Error('Kitten shared eSpeak dependency missing');
      if (standardVoice(config, undefined) !== 0) throw new Error('Kitten default voice must be Jasper');
      EXPECTED_NAMES.forEach((name, sid) => {
        if (standardVoice(config, name) !== sid || standardVoice(config, EXPECTED_ALIASES[sid]!) !== sid) throw new Error('Kitten voice alias mapping mismatch');
      });
      let bucket = '';
      await downloadModel(modelId, { onProgress: e => {
        const next = e.phase === 'downloading' ? `${e.phase}:${Math.floor((e.progress ?? 0) * 10)}` : e.phase;
        if (next !== bucket) { bucket = next; log(`Kitten ${modelId} download ${JSON.stringify(e)}`); }
      } });
      for (let pass = 0; pass < 2; pass++) {
        const phases: string[] = [], start = Date.now();
        const model = await loadTextToSpeech(modelId, { onProgress: e => { phases.push(e.phase); } });
        try {
          if (phases.includes('downloading')) throw new Error('Cached Kitten load unexpectedly downloaded assets');
          log(`Kitten ${modelId} cached load ${pass}: ${Date.now() - start}ms`);
          const voices: Array<string | number | undefined> = pass === 0 ? [undefined, ...EXPECTED_NAMES] : [...EXPECTED_ALIASES, 4];
          for (const voiceId of voices) {
            const row = { modelId, quant, pass, voiceId: voiceId ?? 0, defaultVoice: voiceId === undefined,
              text: RAW_TEXT, ...await synthesize(model, RAW_TEXT, voiceId) };
            results.push(row); log(`Kitten PCM PASS ${JSON.stringify(row)}`);
          }
        } finally { await model.unload(); await model.unload(); }
      }
    }
    return { results, cachedReload: true, voiceAliasesChecked: true, pronunciationQuality: 'not assessed' };
  } finally { active = false; }
}
