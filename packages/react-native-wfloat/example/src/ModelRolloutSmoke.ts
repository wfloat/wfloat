import { Image } from 'react-native';
import { loadLanguageModel, type ModelProgressEvent, type PcmAudio } from '@wfloat/react-native-wfloat';
import { loadTextToSpeech, loadSpeechToText, loadStreamingSpeechToText, downloadModel } from '@wfloat/react-native-wfloat';
/** Development-only public-endpoint fixture. Never runs without an explicit action. */
export async function parakeetSmoke(log: (message: string) => void) {
  const id = 'nvidia/parakeet-tdt-0.6b-v3';
  const tts = await loadTextToSpeech('wfloat/wfloat-tts');
  let audio;
  const generation = tts.generate('Hello. The weather is sunny today.');
  try { audio = (await generation.result()).audio; }
  finally { generation.dispose(); await tts.unload(); }
  let bucket = '';
  await downloadModel(id, { onProgress: e => {
    const next = e.phase === 'downloading' ? `${e.phase}:${Math.floor((e.progress ?? 0) * 10)}` : e.phase;
    if (next !== bucket) { bucket = next; log(`Parakeet download ${JSON.stringify(e)}`); }
  } });
  const results: string[] = [];
  for (let pass = 0; pass < 2; pass++) {
    const phases: string[] = [];
    const model = await loadSpeechToText(id, { onProgress: e => { phases.push(e.phase); log(`Parakeet ${e.phase}`); } });
    try {
      if (phases.includes('downloading')) throw new Error('Cached load downloaded assets');
      const result = await model.transcribe(audio).result();
      if (!result.text.trim()) throw new Error('Empty transcript');
      results.push(result.text); log(`Parakeet transcript ${result.text}`);
      const silence = await model.transcribe({ samples: new Float32Array(16000), sampleRate: 16000 }).result();
      if (silence.text) throw new Error('Digital silence produced text');
      const cancelled = model.transcribe(audio); cancelled.cancel();
      if ((await cancelled.result()).stopReason !== 'cancelled') throw new Error('Cancel failed');
    } finally { await model.unload(); await model.unload(); }
  }
  const live = await loadStreamingSpeechToText(id);
  try {
    const session = await live.createSession();
    await session.push(audio);
    const result = await session.finish();
    if (!result.text.trim()) throw new Error('Windowed session returned no transcript');
    log(`Parakeet live ${result.text}`);
  } finally { await live.unload(); }
  return { modelId: id, results, publicDownload: true, cachedReload: true, cancellation: true, silence: true, windowedSession: true };
}

export async function piperSmoke(log: (message: string) => void) {
  const cases = [
    ['rhasspy/piper-en_US-lessac-medium','Hello, this is a short speech test.'],
    ['rhasspy/piper-en_US-amy-medium','Hello, this is a short speech test.'],
    ['rhasspy/piper-en_GB-alba-medium','The train leaves tomorrow.'],
    ['rhasspy/piper-de_DE-thorsten-medium','Hallo, dies ist ein kurzer Sprachtest.'],
    ['rhasspy/piper-fr_FR-siwis-medium','Bonjour, ceci est un test de voix.'],
    ['rhasspy/piper-en_US-libritts-high','Hello, this is a short speech test.'],
    ['rhasspy/piper-en_US-ryan-medium','Hello, this is a short speech test.'],
  ];
  const results=[];
  for(const [id,text] of cases) {
    log(`Piper loading ${id}`);
    const model=await loadTextToSpeech(id!);
    try {
      for(const voiceId of id!.includes('libritts')?[0,903]:[0]) {
        const g=model.generate(text!,{voiceId});
        try {const r=await g.result();if(!r.audio.samples.length||!r.audio.samples.every(Number.isFinite)||!r.audio.samples.some(x=>Math.abs(x)>.001))throw Error('Invalid PCM');results.push({id,voiceId,seconds:r.audio.samples.length/r.audio.sampleRate});log(`Piper PASS ${JSON.stringify(results.at(-1))}`);}finally{g.dispose();}
      }
    }finally{await model.unload();}
    const phases:string[]=[];const cached=await loadTextToSpeech(id!,{onProgress:e=>phases.push(e.phase)});await cached.unload();if(phases.includes('downloading'))throw Error(`Cached ${id} downloaded again`);
  }
  return {results,cachedReload:true};
}


/** One selectable case per invocation; no batch loads or model URL overrides. */
export const STT_ROLLOUT_CASES = [
  { action: 'sttWhisperTiny', id: 'openai/whisper-tiny', language: 'en', live: false },
  { action: 'sttWhisperBase', id: 'openai/whisper-base', language: 'en', live: false },
  { action: 'sttWhisperSmall', id: 'openai/whisper-small', language: 'en', live: false },
  { action: 'sttMoonshineBase', id: 'moonshine-ai/moonshine-base', language: 'en', live: false },
  { action: 'sttZipformerFrench', id: 'shaojieli/streaming-zipformer-fr', language: 'fr', live: true },
  { action: 'sttZipformerZhEn', id: 'k2-fsa/streaming-zipformer-zh-en', language: 'en', live: true },
] as const;
export const LLM_ROLLOUT_CASES = [
  { action: 'llmQwen06B', id: 'Qwen/Qwen3-0.6B' },
  { action: 'llmQwen17B', id: 'Qwen/Qwen3-1.7B' },
  { action: 'llmQwen4B', id: 'Qwen/Qwen3-4B' },
  { action: 'llmGemma270M', id: 'google/gemma-3-270m-it' },
] as const;
type Log = (message: string) => void;
let activeRollout = false;
async function exclusiveRollout<T>(run: () => Promise<T>): Promise<T> {
  if (activeRollout) throw new Error('A rollout fixture is already running; await it before loading another model.');
  activeRollout = true;
  try { return await run(); } finally { activeRollout = false; }
}
function progressLog(label: string, log: Log) {
  let previous = '';
  return (event: ModelProgressEvent) => {
    const bucket = event.phase === 'downloading' ? `downloading:${Math.floor((event.progress ?? 0) * 10)}` : event.phase;
    if (bucket !== previous) { previous = bucket; log(`${label} ${JSON.stringify(event)}`); }
  };
}
function cachedProgress(label: string, log: Log) {
  const phases: string[] = [];
  const report = progressLog(label, log);
  return { phases, onProgress: (event: ModelProgressEvent) => { phases.push(event.phase); report(event); } };
}
function assertCached(phases: string[]) {
  if (phases.includes('downloading')) throw new Error('Predownloaded/cached model unexpectedly downloaded assets');
}

async function englishAudio(): Promise<PcmAudio> {
  const model = await loadTextToSpeech('wfloat/wfloat-tts');
  try {
    const generation = model.generate('Hello. The weather is sunny today.');
    try {
      const { audio } = await generation.result();
      // Own the small fixture before disposing the generation and unloading TTS.
      return { samples: new Float32Array(audio.samples), sampleRate: audio.sampleRate };
    } finally { generation.dispose(); }
  } finally { await model.unload(); }
}
async function frenchAudio(): Promise<PcmAudio> {
  // Metro serves the bundled fixture in development; model assets still use the
  // public registry. Decode this known PCM WAV in JS, without an extra TTS model.
  const source = Image.resolveAssetSource(require('./assets/french-eight-seconds.wav'));
  const response = await fetch(source.uri);
  if (!response.ok) throw new Error(`French fixture fetch failed: ${response.status}`);
  const data = new DataView(await response.arrayBuffer());
  const tag = (offset: number) => String.fromCharCode(...[0, 1, 2, 3].map(i => data.getUint8(offset + i)));
  if (data.byteLength < 12 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('Invalid French WAV');
  let sampleRate = 0, pcmOffset = -1, pcmBytes = 0;
  for (let offset = 12; offset + 8 <= data.byteLength;) {
    const size = data.getUint32(offset + 4, true), start = offset + 8;
    if (start + size > data.byteLength) throw new Error('Truncated French WAV');
    if (tag(offset) === 'fmt ') {
      if (size < 16 || data.getUint16(start, true) !== 1 || data.getUint16(start + 2, true) !== 1 || data.getUint16(start + 14, true) !== 16) throw new Error('French WAV must be mono PCM16');
      sampleRate = data.getUint32(start + 4, true);
    } else if (tag(offset) === 'data') { pcmOffset = start; pcmBytes = size; }
    offset = start + size + (size % 2);
  }
  if (sampleRate !== 22050 || pcmOffset < 0 || pcmBytes !== 176400 * 2) throw new Error('Expected the pinned eight-second French fixture');
  const samples = new Float32Array(pcmBytes / 2);
  for (let i = 0; i < samples.length; i++) samples[i] = data.getInt16(pcmOffset + i * 2, true) / 32768;
  return { samples, sampleRate };
}

export async function sttRolloutSmoke(id: string, log: Log) {
  const fixture = STT_ROLLOUT_CASES.find(item => item.id === id);
  if (!fixture) throw new Error(`Unknown STT rollout fixture: ${id}`);
  return exclusiveRollout(async () => {
    const audio = await (fixture.language === 'fr' ? frenchAudio() : englishAudio());
    if (!audio.samples.length || !audio.samples.every(Number.isFinite) || !audio.samples.some(x => Math.abs(x) > 0.001)) throw new Error('Invalid speech fixture');
    log(`STT ${id}: ${fixture.language}, ${audio.samples.length / audio.sampleRate}s input`);
    await downloadModel(id, { onProgress: progressLog(id, log) });
    const results: string[] = [];
    for (let pass = 0; pass < 2; pass++) {
      const progress = cachedProgress(`${id} pass ${pass}`, log);
      const model = await loadSpeechToText(id, { onProgress: progress.onProgress });
      try {
        assertCached(progress.phases);
        const result = await model.transcribe(audio, { language: fixture.language }).result();
        if (result.stopReason !== 'complete' || !result.text.trim()) throw new Error('Incomplete/empty transcript');
        results.push(result.text); log(`${id} transcript ${JSON.stringify(result)}`);
        if (pass === 0) {
          const cancelled = model.transcribe(audio, { language: fixture.language }); cancelled.cancel();
          if ((await cancelled.result()).stopReason !== 'cancelled') throw new Error('STT cancel failed');
          const silence = await model.transcribe({ samples: new Float32Array(16000), sampleRate: 16000 }).result();
          if (silence.stopReason !== 'complete' || silence.text.trim()) throw new Error('Silence/reuse after cancellation failed');
        }
      } finally { await model.unload(); }
    }
    let liveText: string | undefined;
    if (fixture.live) {
      const progress = cachedProgress(`${id} streaming`, log);
      const model = await loadStreamingSpeechToText(id, { onProgress: progress.onProgress });
      try {
        assertCached(progress.phases);
        const session = await model.createSession({ language: fixture.language });
        try {
          const chunkSize = Math.floor(audio.sampleRate / 2);
          for (let offset = 0; offset < audio.samples.length; offset += chunkSize) {
            await session.push({ samples: audio.samples.slice(offset, offset + chunkSize), sampleRate: audio.sampleRate });
          }
          const result = await session.finish();
          if (result.stopReason !== 'complete' || !result.text.trim()) throw new Error('Streaming transcript empty/incomplete');
          liveText = result.text; log(`${id} streaming ${JSON.stringify(result)}`);
        } catch (error) { session.cancel(); await session.result().catch(() => {}); throw error; }
      } finally { await model.unload(); }
    }
    return { modelId: id, language: fixture.language, results, liveText, publicAssets: true, cachedReload: true, cancellation: true, silence: true };
  });
}

export async function llmRolloutSmoke(id: string, log: Log) {
  if (!LLM_ROLLOUT_CASES.some(item => item.id === id)) throw new Error(`Unknown LLM rollout fixture: ${id}`);
  return exclusiveRollout(async () => {
    await downloadModel(id, { onProgress: progressLog(id, log) });
    const results = [];
    const reasoning = id.startsWith('Qwen/') ? { reasoning: false } : {};
    for (let pass = 0; pass < 2; pass++) {
      const progress = cachedProgress(`${id} pass ${pass}`, log);
      const model = await loadLanguageModel(id, { contextSize: 2048, numThreads: 2, onProgress: progress.onProgress });
      try {
        assertCached(progress.phases);
        if (model.contextSize !== 2048) throw new Error(`Unexpected context: ${model.contextSize}`);
        const messages = [{ role: 'user' as const, content: 'What is the capital of France? Answer briefly.' }];
        const inputTokens = await model.countInputTokens(messages, reasoning);
        if (inputTokens <= 0 || inputTokens >= 2048) throw new Error('Invalid input token count');
        const result = await model.generate(messages, { ...reasoning, maxTokensPerRound: 64 }).result();
        if (!result.text.trim() || !result.usage.outputTokens) throw new Error('Empty LLM generation');
        results.push({ text: result.text, usage: result.usage, stopReason: result.stopReason, inputTokens });
        log(`${id} generation ${JSON.stringify(results.at(-1))}`);
        if (pass === 0) {
          const cancelled = model.generate([{ role: 'user', content: 'Count from one to one hundred.' }], {
            ...reasoning, maxTokensPerRound: 128, onText: () => cancelled.cancel(),
          });
          if ((await cancelled.result()).stopReason !== 'cancelled') throw new Error('LLM callback cancellation failed');
          const reused = await model.generate([{ role: 'user', content: 'Say hello.' }], { ...reasoning, maxTokensPerRound: 32 }).result();
          if (!reused.text.trim()) throw new Error('LLM reuse after cancellation returned no text');
        }
      } finally { await model.unload(); }
    }
    return { modelId: id, contextSize: 2048, results, publicAssets: true, cachedReload: true, cancellation: true };
  });
}
