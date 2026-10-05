// Separate Chrome process: no autoplay-policy override and no model downloads.
export async function runDefaultAutoplayScenario(chromium, url) {
 const browser=await chromium.launch({
  executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless:true,args:['--mute-audio'],
 });
 try{
  const context=await browser.newContext();const page=await context.newPage();const errors=[];
  page.on('pageerror',error=>errors.push(error));
  // Set up from a document script, not evaluate(): a protocol evaluation can
  // itself carry a user-gesture flag and invalidate the negative control.
  await page.addInitScript(()=>{
   const report=window.autoplayReport={phase:'initializing',creations:[],resumes:[],events:[],peak:0};
   const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
   const boot=async()=>{
    const NativeAudioContext=window.AudioContext;
    const blocked=new NativeAudioContext();
    void blocked.resume().catch(()=>{});
    await sleep(200);report.beforeClickState=blocked.state;await blocked.close();
    const {TextToSpeechModel}=await import('/tts-next/model.js');
    let inClick=false,audioContext,analyser;
    window.AudioContext=class extends NativeAudioContext {
     constructor(...args){
      super(...args);audioContext=this;
      report.creations.push({inClick,active:navigator.userActivation.isActive});
      analyser=this.createAnalyser();analyser.fftSize=256;analyser.connect(this.destination);
     }
     resume(){report.resumes.push({inClick,active:navigator.userActivation.isActive});return super.resume();}
     createBufferSource(){
      const source=super.createBufferSource(),connect=source.connect.bind(source);
      source.connect=()=>connect(analyser);return source;
     }
    };
    const backend={sampleRate:48000,validate(){},
     async prepare(segment){return[{text:segment.text,textStart:0,textEnd:segment.text.length}];},
     async synthesize(){
      const began=performance.now();await sleep(6500);
      report.synthesisDelayMs=performance.now()-began;
      report.activationAtAudioReady=navigator.userActivation.isActive;
      report.contextAtAudioReady=audioContext.state;
      return{samples:Float32Array.from({length:24000},(_,i)=>0.2*Math.sin(i*2*Math.PI*440/48000)),sampleRate:48000};
     },async unload(){}};
    const model=new TextToSpeechModel(backend);
    report.contextsBeforeClick=report.creations.length;
    const button=document.createElement('button');button.textContent='Speak delayed audio';document.body.append(button);
    let monitor;
    button.addEventListener('click',event=>{
     report.trustedClick=event.isTrusted;inClick=true;
     try{
      model.speak('Click-unlocked delayed speech',{onPlayback:event=>{
       report.events.push(event.state);
       if(event.state==='failed'){report.error=String(event.error);report.phase='failed';}
       if(event.state==='finished'){
        clearInterval(monitor);
        void model.unload().then(()=>{report.closedState=audioContext.state;report.phase='complete';},error=>{report.error=String(error);report.phase='failed';});
       }
      }});
     }finally{inClick=false;}
     monitor=setInterval(()=>{
      const samples=new Float32Array(analyser.fftSize);analyser.getFloatTimeDomainData(samples);
      report.peak=Math.max(report.peak,...samples.map(Math.abs));
     },10);
    },{once:true});
    report.phase='ready';
   };
   document.addEventListener('DOMContentLoaded',()=>{void boot().catch(error=>{report.error=String(error);report.phase='failed';});},{once:true});
  });
  await page.goto(url);
  await page.waitForFunction(()=>['ready','failed'].includes(window.autoplayReport?.phase),{},{timeout:10000});
  await page.getByRole('button',{name:'Speak delayed audio'}).click();
  await page.waitForFunction(()=>['complete','failed'].includes(window.autoplayReport?.phase),{},{timeout:15000});
  const report=await page.evaluate(()=>window.autoplayReport);
  if(errors.length)throw new AggregateError(errors,'Default-policy browser errors');
  if(report.phase!=='complete'||report.beforeClickState!=='suspended'||!report.trustedClick||
   report.contextsBeforeClick!==0||report.creations.length!==1||!report.creations[0].inClick||!report.creations[0].active||
   !report.resumes.some(r=>r.inClick&&r.active)||report.activationAtAudioReady!==false||report.contextAtAudioReady!=='running'||
   report.peak<0.1||report.closedState!=='closed'||report.events.filter(s=>s==='finished').length!==1)
   throw Error(`Default autoplay scenario failed: ${JSON.stringify(report)}`);
  return report;
 }finally{await browser.close();}
}
