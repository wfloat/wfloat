import { downloadModel, loadTextToSpeech, type SpeechResult } from '@wfloat/react-native-wfloat';
import { KOKORO_VOICES, kokoroLanguage, standardConfig, standardModel, standardVoice } from '../../src/next/tts-next/families';
import { modelManifest } from '../../src/next/assets';

const MODEL_ID = 'hexgrad/Kokoro-82M';
// Match the saved FP32 Web/WASM qualification: eight routes, seven languages
// (US and UK English are separate routes). PCM checks are not pronunciation QA.
export const KOKORO_ROLLOUT_CASES = [
  { route: 'en-us', voiceId: 'af_heart', text: 'Hello, this is a short speech test.' },
  { route: 'en', voiceId: 'bf_emma', text: 'The train leaves at nine tomorrow.' },
  { route: 'es', voiceId: 'ef_dora', text: 'Hola, esta es una prueba de voz.' },
  { route: 'fr', voiceId: 'ff_siwis', text: 'Bonjour, ceci est un test de voix.' },
  { route: 'hi', voiceId: 'hf_alpha', text: 'नमस्ते, यह एक परीक्षण है।' },
  { route: 'it', voiceId: 'if_sara', text: 'Ciao, questa è una prova della voce.' },
  { route: 'pt', voiceId: 'pf_dora', text: 'Olá, este é um teste de voz.' },
  { route: 'cmn', voiceId: 'zf_xiaobei', text: '你好，现在是下午三点。' },
] as const;

type Model = Awaited<ReturnType<typeof loadTextToSpeech>>;
function audioStats(result: SpeechResult, text: string) {
  const { samples, sampleRate } = result.audio;
  if (sampleRate !== 24000 || !samples.length) throw new Error('Kokoro must return nonempty 24kHz audio');
  let peak = 0, power = 0;
  for (const sample of samples) {
    if (!Number.isFinite(sample)) throw new Error('Kokoro returned non-finite PCM');
    peak = Math.max(peak, Math.abs(sample)); power += sample * sample;
  }
  if (peak <= 0.001) throw new Error('Kokoro returned effectively silent PCM');
  const seconds = samples.length / sampleRate;
  if (seconds > 60) throw new Error('Unexpectedly long audio for a short Kokoro fixture');
  if (!result.timeline.length || result.timeline[0]!.textStart !== 0 || result.timeline.at(-1)!.textEnd !== text.length ||
      result.timeline.map(t => t.text).join('') !== text) throw new Error('Kokoro original-text timeline mismatch');
  return { sampleRate, samples: samples.length, seconds, peak, rms: Math.sqrt(power / samples.length) };
}
async function synthesize(model: Model, text: string, voiceId?: string | number) {
  const start = Date.now();
  const generation = model.generate(text, voiceId === undefined ? {} : { voiceId });
  try { return { ...audioStats(await generation.result(), text), inferenceMs: Date.now() - start }; }
  finally { generation.dispose(); }
}
async function rejectJapanese(model: Model) {
  // Check aliases AND numeric IDs; never accept an unrelated failure as a pass.
  for (let sid = 37; sid <= 41; sid++) for (const voiceId of [sid, KOKORO_VOICES[sid]!]) {
    let generation: ReturnType<Model['generate']> | undefined;
    let rejected = false;
    try { generation = model.generate('今日は東京です。', { voiceId }); await generation.result(); }
    catch (error) { if (!/Japanese frontend/.test(String(error))) throw error; rejected = true; }
    finally { generation?.dispose(); }
    if (!rejected) throw new Error(`Deferred Japanese voice ${voiceId} unexpectedly generated`);
  }
}
let active = false;
/** Explicit parent-invoked development fixture; no automatic execution/playback.
 * Parent must serialize this against other smoke fixtures (eSpeak is global).
 * Entry-point owner: import { kokoroRolloutSmoke } from './KokoroRolloutSmoke'. */
export async function kokoroRolloutSmoke(log: (message: string) => void) {
  if (active) throw new Error('Kokoro fixture is already running');
  active = true;
  try {
    const config = standardConfig(MODEL_ID);
    const manifest = modelManifest(MODEL_ID);
    const modelAsset = manifest.assets.find(a => a.name === 'model_onnx');
    if (standardModel(MODEL_ID)?.quant !== 'fp32' || !modelAsset?.url?.includes('/fp32/')) throw new Error('Kokoro fixture requires the validated FP32 registry model');
    if (!manifest.assets.some(a => a.name === 'espeak_data' && a.shared)) throw new Error('Kokoro shared eSpeak dependency missing');
    for (const c of KOKORO_ROLLOUT_CASES) if (kokoroLanguage(standardVoice(config, c.voiceId)) !== c.route) throw new Error(`Wrong route for ${c.voiceId}`);
    if (standardVoice(config, undefined) !== 0 || KOKORO_VOICES[0] !== 'af_alloy' || KOKORO_VOICES[49] !== 'zm_yunjian') throw new Error('Kokoro pinned voice ordering changed');
    let bucket = '';
    await downloadModel(MODEL_ID, { onProgress: e => {
      const next = e.phase === 'downloading' ? `${e.phase}:${Math.floor((e.progress ?? 0) * 10)}` : e.phase;
      if (next !== bucket) { bucket = next; log(`Kokoro download ${JSON.stringify(e)}`); }
    } });
    const results = [];
    for (let pass = 0; pass < 2; pass++) {
      const phases: string[] = [];
      const start = Date.now();
      const model = await loadTextToSpeech(MODEL_ID, { onProgress: e => { phases.push(e.phase); if (e.phase !== 'downloading') log(`Kokoro pass ${pass}: ${e.phase}`); } });
      try {
        if (phases.includes('downloading')) throw new Error('Cached Kokoro load unexpectedly downloaded assets');
        log(`Kokoro cached load ${pass}: ${Date.now() - start}ms`);
        await rejectJapanese(model);
        const cases: ReadonlyArray<{route: string; voiceId?: string | number; text: string}> = pass === 0 ? [
          { route: 'en-us', text: 'Hello, this uses the default voice.' }, ...KOKORO_ROLLOUT_CASES,
          { route: 'cmn', voiceId: 49, text: '你好，现在是下午三点。' },
          { route: 'en', voiceId: 'bf_emma', text: 'There are 123 books on the shelf.' },
        ] : [
          { route: 'cmn', voiceId: 49, text: '今天是2026年10月5日，现在是下午3点。' },
          { route: 'en-us', voiceId: 'af_heart', text: 'There are 123 books on the shelf.' },
          { route: 'es', voiceId: 53, text: 'Hola, esta es una prueba de voz.' },
        ];
        for (const c of cases) {
          const row = { pass, voiceId: c.voiceId ?? 0, defaultVoice: c.voiceId === undefined, route: c.route, text: c.text, ...await synthesize(model, c.text, c.voiceId) };
          results.push(row); log(`Kokoro PCM PASS ${JSON.stringify(row)}`);
        }
      } finally { await model.unload(); await model.unload(); }
    }
    return { modelId: MODEL_ID, quantization: 'fp32', results, cachedReload: true, japaneseRejected: true, routeTransitions: true, pronunciationQuality: 'not assessed' };
  } finally { active = false; }
}
