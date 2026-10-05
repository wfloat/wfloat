import {loadSpeechToText,loadStreamingSpeechToText} from '/stt-next/load.js';
const assert=(v,message)=>{if(!v)throw Error(message);};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const report={cases:[],done:false};window.sttReport=report;
const log=message=>{console.log('STT',message);document.querySelector('#out').textContent=JSON.stringify(report,null,2)+'\n'+message;};
const wav=await (await fetch('/fixture.wav')).blob();
const audioContext=new AudioContext();
const fixture=await audioContext.decodeAudioData(await wav.arrayBuffer());await audioContext.close();
const pcm={samples:new Float32Array(fixture.getChannelData(0)),sampleRate:fixture.sampleRate};
const ids=['UsefulSensors/moonshine-tiny','openai/whisper-tiny-en','k2-fsa/streaming-zipformer-en'];
document.querySelector('#run').onclick=async()=>{
 document.querySelector('#run').disabled=true;
 try{
  for(const id of ids){
   log('loading '+id);const phases=[];const controller=new AbortController();
   let model=await loadSpeechToText(id,{signal:controller.signal,persistence:'off',onProgress:e=>{if(phases.at(-1)!==e.phase){phases.push(e.phase);log(id+' '+e.phase);}}});
   controller.abort(); // Loader signal no longer owns a ready model.
   try{
    const previews=[];const started=performance.now();
    const op=model.transcribe(wav,{onTranscript:e=>previews.push(e.text)});
    const result=await op.result();assert(result.stopReason==='complete','bad completion');assert(result.text.trim(),'empty speech transcript');
    assert(previews.at(-1)===result.text,'preview/result mismatch');assert(await op.result()===result,'result identity changed');
    report.cases.push({id,case:'file',result,previews,phases,ms:performance.now()-started});log('file okay '+id);
    const first=model.transcribe(pcm);const cancelled=model.transcribe(pcm);cancelled.cancel();
    assert((await cancelled.result()).stopReason==='cancelled','queued cancellation failed');await first.result();
    const silence=await model.transcribe({samples:new Float32Array(16000),sampleRate:16000}).result();
    report.cases.push({id,case:'silence',result:silence});
    const stereo=new AudioBuffer({length:pcm.samples.length,numberOfChannels:2,sampleRate:pcm.sampleRate});
    stereo.copyToChannel(pcm.samples,0);stereo.copyToChannel(pcm.samples,1);
    const stereoOp=model.transcribe(stereo);stereo.getChannelData(0).fill(0);stereo.getChannelData(1).fill(0);
    const stereoResult=await stereoOp.result();assert(stereoResult.text.trim(),'AudioBuffer snapshot/downmix lost audio');
    report.cases.push({id,case:'AudioBuffer',text:stereoResult.text});
    if(id.includes('zipformer')) {
      const biased=await model.transcribe(pcm,{hotwords:['fellow Americans', 'country']}).result();
      assert(biased.text.trim(),'Hotword decoder produced no text');
      report.cases.push({id,case:'hotwords',result:biased});
      const unbiased=await model.transcribe(pcm).result();assert(unbiased.text.trim(),'Reset after hotword decoder failed');
    }

    if(id.includes('whisper')){
      const other=await loadSpeechToText(id,{persistence:'off'});
      try{const independent=await other.transcribe(pcm).result();assert(independent.text.trim(),'Independent instance failed');}
      finally{await other.unload();}
      assert((await model.transcribe(pcm).result()).text.trim(),'Unloading sibling broke original instance');
      const abort=new AbortController();let aborted;
      try{await loadSpeechToText(id,{persistence:'off',signal:abort.signal,onProgress:e=>{if(e.phase==='loading')abort.abort();}});}catch(e){aborted=e;}
      assert(aborted?.name==='AbortError','Load cancellation did not reject AbortError');
      report.cases.push({id,case:'load-cancel-and-independent-instances',ok:true});
      try{const timed=await model.transcribe(pcm,{timestamps:'segment'}).result();report.cases.push({id,case:'timing',result:timed});}
      catch(e){report.cases.push({id,case:'timing',error:String(e)});throw e;}
      const long=new Float32Array(pcm.sampleRate*36);long.set(pcm.samples.subarray(0,Math.min(pcm.samples.length,pcm.sampleRate*10)),0);
      long.set(pcm.samples.subarray(0,Math.min(pcm.samples.length,pcm.sampleRate*10)),pcm.sampleRate*26);
      const full=await model.transcribe({samples:long,sampleRate:pcm.sampleRate},{onTranscript:e=>log('long preview '+e.text)}).result();
      assert(full.text.length>result.text.length,'Long recording lost its second spoken portion');report.cases.push({id,case:'long',result:full});
    }
   }finally{await model.unload();}
   const livePhases=[];model=await loadStreamingSpeechToText(id,{persistence:'off',onProgress:e=>livePhases.push(e.phase)});
   try{
    assert(!livePhases.includes('downloading'),'cached model emitted download progress');
    const events=[];const session=await model.createSession({onTranscript:e=>events.push(e)});
    let rejected=false;try{await model.createSession();}catch{rejected=true;}assert(rejected,'second session accepted');
    const step=Math.round(pcm.sampleRate*0.37);
    for(let offset=0;offset<pcm.samples.length;offset+=step){await session.push({samples:pcm.samples.subarray(offset,offset+step),sampleRate:pcm.sampleRate});}
    const result=await session.finish();assert(result.text.trim(),'empty live transcript');
    assert(result.segments.map(s=>s.id).every((id,i)=>id===String(i)),'bad IDs');
    assert(events.filter(e=>e.isFinal).map(e=>e.text).join(' ')===result.text,'live event/result mismatch');
    report.cases.push({id,case:'live',result,events,phases:livePhases});
    if(id.includes('zipformer')) {
      const biasedSession=await model.createSession({hotwords:['fellow Americans', 'country']});
      await biasedSession.push(pcm);const biased=await biasedSession.finish();assert(biased.text.trim(),'Live hotwords failed');
      report.cases.push({id,case:'live-hotwords',result:biased});
    }
    if(id.includes('whisper')) {
      const long=new Float32Array(pcm.sampleRate*33);
      for(let i=0;i<long.length;i++)long[i]=pcm.samples[i%pcm.samples.length];
      const rollingEvents=[];const rolling=await model.createSession({onTranscript:e=>rollingEvents.push(e)});
      await rolling.push({samples:long.subarray(0,pcm.sampleRate*25),sampleRate:pcm.sampleRate});
      for(let i=0;i<900&&!rollingEvents.length;i++)await sleep(100);
      assert(rollingEvents.length,'Live offline recognition did not update before finish');
      await rolling.push({samples:long.subarray(pcm.sampleRate*25),sampleRate:pcm.sampleRate});
      const rolled=await rolling.finish();assert(rolled.text.trim(),'Rolling window lost text');
      report.cases.push({id,case:'live-window-rollover',result:rolled,events:rollingEvents});
      const stopping=await model.createSession();await stopping.push(pcm);stopping.cancel();
      assert((await stopping.result()).stopReason==='cancelled','Active offline cancellation failed');
    }
    const cancelled=await model.createSession();cancelled.cancel();assert((await cancelled.result()).stopReason==='cancelled','live cancellation failed');
    let failure;const bounded=await model.createSession({maxBufferedAudioMs:20,onError:e=>failure=e});
    await bounded.push(pcm);let error;try{await bounded.result();}catch(e){error=e;}await sleep(0);
    assert(error&&error===failure,'backlog failure notification/result mismatch');
    report.cases.push({id,case:'backlog',error:String(error)});
   }finally{await model.unload();}
  }
 }catch(e){report.failed=String(e);report.stack=e.stack;console.error(e);}
 finally{report.done=true;log('done');await fetch('/report',{method:'POST',body:JSON.stringify(report)});}
};
document.querySelector('#mic').onclick=async()=>{
 const button=document.querySelector('#mic');button.disabled=true;button.textContent='Preparing microphone model…';
 try{
  const model=await loadStreamingSpeechToText('k2-fsa/streaming-zipformer-en',{persistence:'off'});
  const events=[];const session=await model.createSession({onTranscript:e=>{events.push(e);log('microphone '+e.text);},onError:e=>console.error(e)});
  window.micReady=true;button.textContent='Start microphone for 12 seconds';button.disabled=false;
  button.onclick=()=>{
   button.disabled=true;const r={done:false};window.micReport=r;
   // startMicrophone must run directly on this click, after preparation.
   session.startMicrophone().then(async()=>{
    await sleep(12000);r.result=await session.finish();r.events=events;
    assert(r.result.stopReason==='complete','microphone did not complete');
   }).catch(e=>{r.failed=String(e);r.stack=e.stack;}).finally(async()=>{
    await model.unload();r.done=true;button.textContent=r.failed?'Microphone failed':'Microphone passed';
    await fetch('/report',{method:'POST',body:JSON.stringify(r)});
   });
  };
 }catch(e){window.micReport={done:true,failed:String(e)};button.textContent='Microphone preparation failed';}
};

window.sttReady = true;
