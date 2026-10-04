import {loadVoiceActivityDetection,createMicrophoneCapture,loadStreamingSpeechToText} from '/vad-next/load.js';
const out=document.querySelector('#out');
const assert=(x,message)=>{if(!x)throw Error(message);};
const log=x=>{out.textContent+='\n'+x;console.log('VAD',x);};
window.vadReady=true;
document.querySelector('#run').onclick=async()=>{
const checks=[];let model;
try {
 model=await loadVoiceActivityDetection('snakers4/silero-vad');log('loaded');
 const blob=await (await fetch('/fixture.wav')).blob();const probabilities=[];
 const file=await model.detect(blob,{returnAudio:true,onProbability:e=>probabilities.push(e)}).result();
 assert(file.segments.length>0,'speech detected');assert(probabilities.some(e=>e.probability>.5),'raw meaningful scores');assert(probabilities.every(e=>e.probability>=0&&e.probability<=1),'score bounds');
 for(const s of file.segments) assert(Math.abs(s.audio.samples.length/16-(s.endMs-s.startMs))<.01,'clip/time consistency');checks.push({name:'file clips/raw scores',segments:file.segments.map(({audio,...r})=>r),scores:probabilities.length});
 const ctx=new AudioContext();const decoded=await ctx.decodeAudioData(await blob.arrayBuffer());const pcm={samples:decoded.getChannelData(0),sampleRate:decoded.sampleRate};await ctx.close();
 const ends=[],starts=[];const session=await model.createSession({returnAudio:true,onSpeechStart:e=>starts.push(e),onSpeechEnd:e=>ends.push(e)});
 for(let i=0;i<pcm.samples.length;i+=1777)await session.push({samples:pcm.samples.slice(i,i+1777),sampleRate:pcm.sampleRate});
 const live=await session.finish();assert(JSON.stringify(live.segments)===JSON.stringify(file.segments.map(({audio,...r})=>r)),'file/live equivalent');assert(ends.length===live.segments.length&&starts.length===ends.length,'matched callbacks');assert(live.segments.every(s=>!('audio'in s)),'live timing only');checks.push({name:'irregular live input/file parity',segments:live.segments.length});
 const silence=await model.detect({samples:new Float32Array(16000),sampleRate:16000}).result();assert(!silence.segments.length,'silence');checks.push({name:'silence'});
 const cancelled=await model.createSession();await cancelled.push(pcm);cancelled.cancel();assert((await cancelled.result()).stopReason==='cancelled','cancel outcome');checks.push({name:'cancel queued audio'});
 const longSamples=new Float32Array(pcm.samples.length*3);for(let i=0;i<3;i++)longSamples.set(pcm.samples,i*pcm.samples.length);
 const long=await model.detect({samples:longSamples,sampleRate:pcm.sampleRate},{returnAudio:true,minSilenceDurationMs:60000}).result();assert(long.segments.length===1&&long.segments[0].endMs>30000,'long speech not split by hidden engine limit');assert(long.segments[0].audio.samples.length>16000*30,'long clip retained intact');checks.push({name:'33-second unsplit clip',endMs:long.segments[0].endMs});
 window.vadModel=model;window.vadReport={done:true,checks};log('file/live checks passed');
}catch(e){console.error(e);window.vadReport={done:true,failed:String(e),checks};}
};
document.querySelector('#mic').onclick=async()=>{
try {const m=window.vadModel;const other=await loadVoiceActivityDetection('snakers4/silero-vad');const stt=await loadStreamingSpeechToText('UsefulSensors/moonshine-tiny');const transcription=await stt.createSession();const events=[];
 const a=await m.createSession({onSpeechEnd:e=>events.push(e)}),b=await other.createSession();const mic=createMicrophoneCapture();await a.attachMicrophone(mic);await b.attachMicrophone(mic);await transcription.attachMicrophone(mic);await mic.start();
 await new Promise(r=>setTimeout(r,7000));a.cancel();await new Promise(r=>setTimeout(r,6000));await mic.stop();const r=await b.finish();assert(r.segments.length>0,'sibling keeps receiving microphone');assert((await a.result()).stopReason==='cancelled','cancel sibling');const transcript=await transcription.finish();assert(transcript.text.length>0,'shared STT received speech');await Promise.all([m.unload(),other.unload(),stt.unload()]);window.micReport={done:true,segments:r.segments.length,events:events.length,text:transcript.text};log('shared mic passed');
}catch(e){console.error(e);window.micReport={done:true,failed:String(e)};}
};
