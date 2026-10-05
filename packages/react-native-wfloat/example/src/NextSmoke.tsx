import { kittenRolloutSmoke } from './KittenRolloutSmoke';
import { kokoroRolloutSmoke } from './KokoroRolloutSmoke';
import { parakeetSmoke, piperSmoke, sttRolloutSmoke, llmRolloutSmoke, STT_ROLLOUT_CASES, LLM_ROLLOUT_CASES } from './ModelRolloutSmoke';
import { gemmaSmoke, gemmaPublicProbe } from './GemmaSmoke';
import { useEffect, useRef, useState } from 'react';
import { Button, Platform, SafeAreaView, ScrollView, Text } from 'react-native';
import {
  loadVoiceActivityDetection, loadTextToSpeech, loadSpeechToText,
  loadLanguageModel, createMicrophoneCapture, downloadModel,
  type MicrophoneCapture, type VadSession,
} from '@wfloat/react-native-wfloat';

/** Development fixture; explicit buttons avoid unsolicited recording/downloads. */
export default function NextSmoke() {
  const [lines,setLines]=useState<string[]>([]);
  const [busy,setBusy]=useState(false);
  const running=useRef(false);
  const [capture,setCapture]=useState<{mic:MicrophoneCapture;session:VadSession;unload:()=>Promise<void>}|null>(null);
  const log=(message:string)=>{console.log(`[WfloatNextSmoke:${Platform.OS}] ${message}`);setLines(old=>[...old.slice(-59),message]);};
  async function invoke<T>(name:string,fn:()=>Promise<T>):Promise<T> {
    if(running.current)throw new Error('A smoke fixture is already running');
    running.current=true;setBusy(true);log(`START ${name}`);
    try{const result=await fn();log(`PASS ${name}`);return result;}
    catch(error){log(`FAIL ${name}: ${String(error)}`);throw error;}
    finally{running.current=false;setBusy(false);}
  }
  const run=async(name:string,fn:()=>Promise<void>)=>{await invoke(name,fn).catch(()=>{});};
  const rolloutActions:Record<string,()=>Promise<unknown>>=Object.fromEntries([
    ...STT_ROLLOUT_CASES.map(({action,id})=>[action,()=>invoke(action,async()=>{
      if(capture)throw new Error('Finish microphone capture before a rollout fixture');
      return sttRolloutSmoke(id,log);
    })]),
    ...LLM_ROLLOUT_CASES.map(({action,id})=>[action,()=>invoke(action,async()=>{
      if(capture)throw new Error('Finish microphone capture before a rollout fixture');
      return llmRolloutSmoke(id,log);
    })]),
  ]);
  const vadTest=async(includeFile=false)=>{
    const id='snakers4/silero-vad';
    await downloadModel(id,{onProgress:e=>log(`download ${JSON.stringify(e)}`)});
    const [a,b]=await Promise.all([loadVoiceActivityDetection(id),loadVoiceActivityDetection(id)]);
    try{
      const audio={samples:new Float32Array(16000),sampleRate:16000};
      const results=await Promise.all([a.detect(audio).result(),b.detect(audio).result()]);
      if(results.some(r=>r.segments.length!==0))throw new Error('Silence produced speech');
      if (includeFile && Platform.OS === 'android') { const file = await b.detect({uri:'file:///data/user/0/wfloat.example/files/silence.wav'}).result(); if(file.segments.length)throw new Error('Decoded silence produced speech'); log('Stereo WAV URI decoding/resampling verified'); }
      await a.unload();await b.detect(audio).result();log('Independent VAD instances and silent audio verified');
    }finally{await Promise.allSettled([a.unload(),b.unload()]);}
  };
  const speechTest=async()=>{
    const tts=await loadTextToSpeech('wfloat/wfloat-tts',{onProgress:e=>log(`tts ${e.phase}`)});
    const generated=tts.generate('Hello. This is speech generated on this device.');
    try{
      const result=await generated.result();if(!result.audio.samples.length)throw new Error('No audio');
      log(`audio ${result.audio.samples.length} @ ${result.audio.sampleRate}`);
      const stt=await loadSpeechToText('openai/whisper-tiny-en',{onProgress:e=>log(`stt ${e.phase}`)});
      try {log(`transcript ${(await stt.transcribe(result.audio).result()).text}`);}finally{await stt.unload();}
      await new Promise<void>((resolve,reject)=>{
        generated.speak({onPlayback:e=>{log(`playback ${e.state}`);if(e.state==='finished')resolve();if(e.state==='failed')reject(e.error);}});
      });
    }finally{generated.dispose();await tts.unload();}
  };
  const pocketTest=async()=>{
    const id='kyutai/pocket-tts';
    const model=await loadTextToSpeech(id,{onProgress:e=>log(`pocket ${e.phase}`)});
    const options={seed:42,inferenceSteps:1,temperature:0.7};
    try {
      const generation=model.generate('Hello from Pocket on this device.',options);
      try {
        const a=await generation.result();
        if(a.audio.sampleRate!==24000||!a.audio.samples.length||a.audio.samples.some(x=>!Number.isFinite(x))||!a.audio.samples.some(x=>Math.abs(x)>1e-5))throw new Error('Invalid Pocket audio');
        log(`Pocket audio ${a.audio.samples.length} @ ${a.audio.sampleRate}`);
        const repeat=model.generate('Hello from Pocket on this device.',options);
        try {const b=await repeat.result();if(b.audio.samples.length!==a.audio.samples.length||b.audio.samples.some((v,i)=>v!==a.audio.samples[i]))throw new Error('Pocket seeded output changed');}finally{repeat.dispose();}
        const dialogue=model.generateDialogue([{text:'Hello.',referenceAudio:a.audio},{text:'Goodbye.',voiceId:'alba'}],options);
        try {const d=await dialogue.result();if(!d.audio.samples.length||!d.timeline.some(t=>t.segmentIndex===1))throw new Error('Missing Pocket dialogue segment');}finally{dialogue.dispose();}
        await new Promise<void>((resolve,reject)=>{
          const timer=setTimeout(()=>{speech.cancel();reject(new Error('Pocket playback timed out'));},30000);
          const speech=generation.speak({onPlayback:e=>{log(`pocket playback ${e.state}`);if(e.state==='finished'){clearTimeout(timer);resolve();}if(e.state==='failed'){clearTimeout(timer);reject(e.error);}}});
        });
      }finally{generation.dispose();}
    }finally{await model.unload();}
    const phases:string[]=[];
    const cached=await loadTextToSpeech(id,{onProgress:e=>phases.push(e.phase)});
    await cached.unload();
    if(phases.includes('downloading'))throw new Error('Pocket cached reload downloaded again');
    log('Pocket seed, reference dialogue, playback and cached reload verified');
  };
  const llmTest=async()=>{
    const llm=await loadLanguageModel('HuggingFaceTB/SmolLM2-360M-Instruct',{contextSize:1024,onProgress:e=>log(`llm ${e.phase}`)});
    try{
      const generation=llm.generate([{role:'user',content:'Say hello in one short sentence.'}],{maxTokensPerRound:32,onText:text=>log(`text ${text}`)});
      const result=await generation.result();log(`llm result ${JSON.stringify(result)}`);
      const structured=await llm.generate([{role:'user',content:'Return an object with name equal to Ada.'}],{structuredOutput:{schema:{type:'object',properties:{name:{type:'string'}},required:['name'],additionalProperties:false}},maxTokensPerRound:64}).result();
      log(`structured ${JSON.stringify(structured.output)}`);
      const stopped=llm.generate([{role:'user',content:'Count from one to one hundred.'}],{maxTokensPerRound:128,onText:()=>stopped.cancel()});
      const cancelled=await stopped.result();if(cancelled.stopReason!=='cancelled')throw new Error('Cancellation did not settle as cancelled');const reused=await llm.generate([{role:'user',content:'Say hello again.'}],{maxTokensPerRound:16}).result();
      if(!reused.text.trim())throw new Error('LLM reuse after cancellation returned no text');
      log('LLM token callback cancellation and same-instance reuse verified');
    }finally{await llm.unload();}
  };
  const startMic=async(backgroundBehavior:'continue'|'pauseAndAutoResume'|'pauseUntilResumed'='pauseUntilResumed')=>{
    const model=await loadVoiceActivityDetection('snakers4/silero-vad');
    try{
      const session=await model.createSession({onSpeechStart:e=>log(`speech start ${e.id}`),onSpeechEnd:e=>log(`speech end ${e.id}`),onError:e=>log(`mic error ${e.message}`)});
      const mic=createMicrophoneCapture({voiceProcessing:true,backgroundBehavior,onCaptureState:e=>log(`capture ${e.state}`)});
      await session.attachMicrophone(mic);await mic.start();setCapture({mic,session,unload:()=>model.unload()});
    }catch(error){await model.unload();throw error;}
  };
  const backgroundSpeech=async()=>{
    const model=await loadTextToSpeech('wfloat/wfloat-tts');
    const probe={state:'starting',updates:0,highlights:[] as string[]};
    (globalThis as typeof globalThis & {__wfloatSpeechProbe?:typeof probe}).__wfloatSpeechProbe=probe;
    try {
      await new Promise<void>((resolve,reject)=>{
        const playback=model.speak(Array.from({length:16},(_,i)=>`This is sentence number ${i+1}.`).join(' '),{
          backgroundBehavior:'continue',
          onPlayback:event=>{
            probe.state=event.state;probe.updates++;
            if(event.highlight&&!probe.highlights.includes(event.highlight.text))probe.highlights.push(event.highlight.text);
            if(event.state==='finished')resolve();
            if(event.state==='failed')reject(event.error);
          },
        });
        if (__DEV__) (globalThis as typeof globalThis & {__wfloatSpeechControl?:typeof playback}).__wfloatSpeechControl=playback;
      });
      return probe;
    } finally {await model.unload();}
  };
  // Development-only entry points for the native smoke-test driver (Hermes CDP).
  useEffect(()=>{
    if (!__DEV__) return;
    const target=globalThis as typeof globalThis & {__wfloatSmoke?:Record<string,unknown>};
    target.__wfloatSmoke={
      ...rolloutActions,
      vad:()=>vadTest(),vadFile:()=>vadTest(true),speech:speechTest,pocket:pocketTest,parakeet:()=>parakeetSmoke(log),piper:()=>piperSmoke(log),kokoro:()=>kokoroRolloutSmoke(log),kitten:()=>kittenRolloutSmoke(log),gemma:()=>gemmaSmoke(log),gemmaPublicProbe:()=>gemmaPublicProbe(log),backgroundSpeech,llm:llmTest,startMic,
      resumeMic:async()=>{if(!capture)throw new Error('No capture');await capture.mic.start();},
      finishMic:async()=>{if(!capture)throw new Error('No capture');const owned=capture;try{await owned.mic.stop();return await owned.session.finish();}finally{await owned.unload();setCapture(null);}},
    };
    return ()=>{delete target.__wfloatSmoke;};
  });
  return <SafeAreaView style={{flex:1,padding:20}}><Text>Wfloat redesigned native SDK tests</Text>
    <Button title="VAD & independent models" disabled={busy} onPress={()=>void run('VAD',()=>vadTest())}/>
    <Button title="TTS → STT → playback" disabled={busy} onPress={()=>void run('speech',speechTest)}/>
    <Button title="Gemma multi-GGUF" disabled={busy} onPress={()=>void run('Gemma',async()=>{await gemmaSmoke(log);})}/>
    <Button title="Pocket TTS" disabled={busy} onPress={()=>void run('Pocket',pocketTest)}/>
    <Button title="LLM & structured output" disabled={busy} onPress={()=>void run('LLM',llmTest)}/>
    <ScrollView style={{maxHeight:240}}>
      <Button title="Parakeet rollout" disabled={busy||!!capture} onPress={()=>void run('Parakeet',async()=>{await parakeetSmoke(log);})}/>
      <Button title="Piper rollout" disabled={busy||!!capture} onPress={()=>void run('Piper',async()=>{await piperSmoke(log);})}/>
      <Button title="Kitten rollout" disabled={busy||!!capture} onPress={()=>void run('Kitten',async()=>{await kittenRolloutSmoke(log);})}/>
      {[...STT_ROLLOUT_CASES,...LLM_ROLLOUT_CASES].map(({action,id})=><Button key={action} title={`Rollout: ${id}`} disabled={busy||!!capture} onPress={()=>void rolloutActions[action]!().catch(()=>{})}/>)}
    </ScrollView>
    <Button title="Start voice-processed mic" disabled={busy||!!capture} onPress={()=>void run('mic start',()=>startMic())}/>
    <Button title="Resume microphone" disabled={busy||!capture} onPress={()=>void run('mic resume',async()=>{await capture!.mic.start();})}/>
    <Button title="Finish microphone" disabled={busy||!capture} onPress={()=>void run('mic finish',async()=>{const owned=capture!;try{await owned.mic.stop();log(JSON.stringify(await owned.session.finish()));}finally{await owned.unload();setCapture(null);}})}/>
    <ScrollView>{lines.map((line,i)=><Text key={i} selectable>{line}</Text>)}</ScrollView>
  </SafeAreaView>;
}
