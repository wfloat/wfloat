import { loadVoiceActivityDetection, createMicrophoneCapture, type VadSessionResult } from '../../src/index.js';
const model = await loadVoiceActivityDetection('snakers4/silero-vad');
const audio = {samples:new Float32Array(16000),sampleRate:16000};
const result = await model.detect(audio, {returnAudio:true}).result();
result.segments[0].audio.samples;
const plain = await model.detect(audio).result();
// @ts-expect-error Audio was not requested.
plain.segments[0].audio;
const session = await model.createSession({returnAudio:true, onSpeechEnd(event) { event.audio.samples; }, onProbability(event) { const n:number=event.probability; }});
const mic = createMicrophoneCapture();
await session.attachMicrophone(mic);
await mic.start(); await mic.stop();
const final:VadSessionResult = await session.finish();
// @ts-expect-error Live final summary never retains audio.
final.segments[0].audio;
await model.unload();
declare const includeAudio: boolean;
const dynamic = await model.detect(audio, {returnAudio:includeAudio}).result();
if ('audio' in dynamic.segments[0]) dynamic.segments[0].audio.samples;
