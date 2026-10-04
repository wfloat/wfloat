import { useEffect, useState } from 'react';
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
  const [capture,setCapture]=useState<{mic:MicrophoneCapture;session:VadSession;unload:()=>Promise<void>}|null>(null);
  const log=(message:string)=>{console.log(`[WfloatNextSmoke:${Platform.OS}] ${message}`);setLines(old=>[...old.slice(-59),message]);};
  const run=async(name:string,fn:()=>Promise<void>)=>{
    if(busy)return;setBusy(true);log(`START ${name}`);
    try{await fn();log(`PASS ${name}`);}catch(error){log(`FAIL ${name}: ${String(error)}`);}finally{setBusy(false);}
  };
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
  const llmTest=async()=>{
    const llm=await loadLanguageModel('HuggingFaceTB/SmolLM2-360M-Instruct',{contextSize:1024,onProgress:e=>log(`llm ${e.phase}`)});
    try{
      const generation=llm.generate([{role:'user',content:'Say hello in one short sentence.'}],{maxTokensPerRound:32,onText:text=>log(`text ${text}`)});
      const result=await generation.result();log(`llm result ${JSON.stringify(result)}`);
      const structured=await llm.generate([{role:'user',content:'Return an object with name equal to Ada.'}],{structuredOutput:{schema:{type:'object',properties:{name:{type:'string'}},required:['name'],additionalProperties:false}},maxTokensPerRound:64}).result();
      log(`structured ${JSON.stringify(structured.output)}`);
      const stopped=llm.generate([{role:'user',content:'Count from one to one hundred.'}],{maxTokensPerRound:128,onText:()=>stopped.cancel()});
      const cancelled=await stopped.result();if(cancelled.stopReason!=='cancelled')throw new Error('Cancellation did not settle as cancelled');log('LLM token callback cancellation verified');
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
      vad:()=>vadTest(),vadFile:()=>vadTest(true),speech:speechTest,backgroundSpeech,llm:llmTest,startMic,
      resumeMic:async()=>{if(!capture)throw new Error('No capture');await capture.mic.start();},
      finishMic:async()=>{if(!capture)throw new Error('No capture');const owned=capture;try{await owned.mic.stop();return await owned.session.finish();}finally{await owned.unload();setCapture(null);}},
    };
    return ()=>{delete target.__wfloatSmoke;};
  });
  return <SafeAreaView style={{flex:1,padding:20}}><Text>Wfloat redesigned native SDK tests</Text>
    <Button title="VAD & independent models" disabled={busy} onPress={()=>void run('VAD',()=>vadTest())}/>
    <Button title="TTS → STT → playback" disabled={busy} onPress={()=>void run('speech',speechTest)}/>
    <Button title="LLM & structured output" disabled={busy} onPress={()=>void run('LLM',llmTest)}/>
    <Button title="Start voice-processed mic" disabled={busy||!!capture} onPress={()=>void run('mic start',()=>startMic())}/>
    <Button title="Resume microphone" disabled={busy||!capture} onPress={()=>void run('mic resume',async()=>{await capture!.mic.start();})}/>
    <Button title="Finish microphone" disabled={busy||!capture} onPress={()=>void run('mic finish',async()=>{const owned=capture!;try{await owned.mic.stop();log(JSON.stringify(await owned.session.finish()));}finally{await owned.unload();setCapture(null);}})}/>
    <ScrollView>{lines.map((line,i)=><Text key={i} selectable>{line}</Text>)}</ScrollView>
  </SafeAreaView>;
}
