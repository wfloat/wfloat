// Runs inside Chromium; synthetic PCM keeps lifecycle experiments independent of inference latency.
export async function runPlaybackScenarios() {
 const { WebAudioPlayback } = await import('/tts-next/playback.js');
 const assert=(v,m)=>{if(!v)throw Error(m);};
 const sleep=ms=>new Promise(r=>setTimeout(r,ms));
 const chunk=startMs=>({audio:{samples:new Float32Array(4800).fill(0.01),sampleRate:48000},startMs,timeline:[]});
 const context=new AudioContext();await context.resume();
 const native=context.createBuffer.bind(context);
 context.createBuffer=(...args)=>{
  const result=native(...args);
  const until=performance.now()+180;while(performance.now()<until){}
  return result;
 };
 const player=new WebAudioPlayback(context);
 try{
  await player.start([chunk(0)],0);
  assert(player.positionMs()<50,`Allocation consumed unscheduled audio: ${player.positionMs()}ms`);
  await sleep(160);
  player.append([chunk(100)]);
  assert(player.positionMs()<150,`Late append skipped unscheduled audio: ${player.positionMs()}ms`);
  player.stop();await player.start([chunk(100)],150);
  assert(player.positionMs()<180,`Resume consumed unscheduled audio: ${player.positionMs()}ms`);
 }finally{player.close();await context.close();}
 const { TextToSpeechModel } = await import('/tts-next/model.js');
 const until=async fn=>{for(let i=0;i<300;i++){if(fn())return;await sleep(10);}throw Error('Playback condition timed out');};
 let syntheses=0;
 const backend={sampleRate:48000,validate(){},async prepare(segment){return[{text:segment.text,textStart:0,textEnd:segment.text.length}];},
  async synthesize(){syntheses++;return{samples:new Float32Array(9600).fill(0.01),sampleRate:48000};},async unload(){}};
 const model=new TextToSpeechModel(backend);const events=[],replayed=[];
 try{
  const g=model.generateDialogue([{text:'One',pauseAfterMs:300},{text:'Two',pauseAfterMs:100}]);
  await g.finished;
  let first;let paused=false;
  first=g.speak({onPlayback:e=>{events.push(e);if(e.state==='playing'&&e.highlight===null&&!paused){paused=true;first.pause();}}});
  await until(()=>events.at(-1)?.state==='paused');
  const count=events.length;await sleep(100);assert(events.length===count,'Paused playback emitted an event');
  const second=g.speak({onPlayback:e=>replayed.push(e)});
  await until(()=>replayed.some(e=>e.state==='playing'));first.resume();
  await until(()=>replayed.at(-1)?.state==='paused');
  await until(()=>events.at(-1)?.state==='finished');
  assert(replayed.at(-1).state==='paused','Finishing first speech automatically resumed second');
  first.resume();await sleep(40);assert(events.at(-1).state==='finished','Completed handle restarted');
  second.resume();await until(()=>replayed.at(-1)?.state==='finished');
  assert(syntheses===2,'Replay regenerated audio');
  let disposed;const disposedEvents=[];
  disposed=g.speak({onPlayback:e=>{disposedEvents.push(e);if(e.state==='playing')g.dispose();}});
  await until(()=>disposedEvents.at(-1)?.state==='cancelled');disposed.resume();await sleep(50);
  assert(disposedEvents.filter(e=>e.state==='cancelled').length===1,'Disposal emitted multiple terminal events');
  assert(disposedEvents.at(-1).highlight===null,'Terminal highlight was not cleared');
 }finally{await model.unload();}
 // A failed native start leaves an unstarted node: stop() on that node is
 // itself an InvalidStateError. Cleanup must still deliver the original failure.
 const start=AudioBufferSourceNode.prototype.start;
 const failure=Error('injected native source start failure');const failures=[];
 const failedModel=new TextToSpeechModel(backend);
 try{
  const g=failedModel.generate('Failure isolation');await g.finished;
  AudioBufferSourceNode.prototype.start=function(){throw failure;};
  g.speak({onPlayback:e=>failures.push(e)});
  await until(()=>failures.some(e=>e.state==='failed'));
  assert(failures.at(-1).error===failure,'Cleanup replaced the original playback error');
  AudioBufferSourceNode.prototype.start=start;
  const recovered=[];g.speak({onPlayback:e=>recovered.push(e)});
  await until(()=>recovered.at(-1)?.state==='finished');
  assert((await g.result()).audio.samples.length>0,'Playback failure damaged generation');
 }finally{AudioBufferSourceNode.prototype.start=start;await failedModel.unload();}
 const handoffModel=new TextToSpeechModel(backend);const histories=Array.from({length:12},()=>[]);
 try{
  const g=handoffModel.generate('Rapid handoffs');await g.finished;
  const handles=histories.map(history=>g.speak({onPlayback:e=>history.push(e.state)}));
  for(let i=0;i<36;i++){
   handles[i%handles.length].resume();
   if(i%3===0)await sleep(5);
  }
  await handoffModel.unload();await sleep(50);
  for(const states of histories){
   const terminal=states.filter(s=>['finished','failed','cancelled'].includes(s));
   assert(terminal.length===1&&states.at(-1)===terminal[0],'Rapid handoff/unload lost terminal ordering');
  }
 }finally{await handoffModel.unload();}
 // Inspect the rendered Web Audio signal, not just callback state or source calls.
 const signalContext=new AudioContext();await signalContext.resume();
 const analyser=signalContext.createAnalyser();analyser.fftSize=256;analyser.connect(signalContext.destination);
 const makeSource=signalContext.createBufferSource.bind(signalContext);
 signalContext.createBufferSource=()=>{const source=makeSource();const connect=source.connect.bind(source);source.connect=()=>connect(analyser);return source;};
 const signalModel=new TextToSpeechModel({...backend,async synthesize(){return{samples:new Float32Array(48000).fill(0.2),sampleRate:48000};}},()=>new WebAudioPlayback(signalContext));
 const levels={};const level=()=>{const samples=new Float32Array(analyser.fftSize);analyser.getFloatTimeDomainData(samples);return Math.max(...samples.map(Math.abs));};
 try{
  const g=signalModel.generate('Signal');await g.finished;const states=[];
  const first=g.speak({onPlayback:e=>states.push(e.state)});
  await until(()=>level()>0.1);levels.playing=level();first.pause();
  await until(()=>level()<0.001);levels.paused=level();first.resume();
  await until(()=>level()>0.1);levels.resumed=level();
  const second=g.speak();await until(()=>states.at(-1)==='paused');await sleep(70);
  levels.handoff=level();assert(levels.handoff>0.1&&levels.handoff<0.3,'Handoff overlapped or lost audio');
  g.dispose();await until(()=>level()<0.001);levels.disposed=level();second.resume();await sleep(70);
  assert(level()<0.001,'Disposed handle restarted audio');
 }finally{await signalModel.unload();await signalContext.close();}
 return {allocationStalls:'passed',nativeStartFailure:'passed',rapidHandoffs:'passed',renderedSignal:levels,syntheses,events:events.map(e=>e.state),replayed:replayed.map(e=>e.state)};
}
