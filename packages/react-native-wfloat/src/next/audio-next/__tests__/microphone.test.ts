const mockRequest=jest.fn();
let mockEvent:(event:any)=>void;
let mockForeground:(state:string)=>void;
const mockDetach=jest.fn();
jest.mock('react-native',()=>({Platform:{OS:'ios'},AppState:{addEventListener:(_name:string,listener:(state:string)=>void)=>{mockForeground=listener;return{remove:jest.fn()};}}}));
jest.mock('../../platform/bridge',()=>({
 request:(...args:unknown[])=>mockRequest(...args),
 uniqueId:(prefix:string)=>prefix,
 subscribe:(_id:string,listener:(event:any)=>void)=>{mockEvent=listener;return mockDetach;},
 notify:(callback:any,event:any)=>callback?.(event),
 abortError:()=>Object.assign(new Error('Aborted'),{name:'AbortError'}),
 checkAbort:()=>{},
}));
import {createMicrophoneCapture,attachCapture,startMicrophone} from '../microphone';
beforeEach(()=>{jest.clearAllMocks();mockRequest.mockResolvedValue(null);});
it('replays missing audio without duplicating already delivered frames',async()=>{
 const mic=createMicrophoneCapture();const received:number[]=[];
 attachCapture(mic,a=>received.push(a.samples[0]!),()=>{});
 await mic.start();
 mockEvent({type:'audio',sequence:1,samples:[1],sampleRate:16000});
 mockRequest.mockImplementation(async(command)=>command.op==='micDrain'?[{sequence:1,samples:[1],sampleRate:16000},{sequence:2,samples:[2],sampleRate:16000}]:null);
 mockForeground('active');
 for(let i=0;i<5;i++)await Promise.resolve();
 expect(received).toEqual([1,2]);
 mockEvent({type:'audio',sequence:2,samples:[2],sampleRate:16000});
 expect(received).toEqual([1,2]);
 await mic.stop();
});
it('resumes with original options but never restarts after stop',async()=>{
 const mic=createMicrophoneCapture({voiceProcessing:true,backgroundBehavior:'pauseUntilResumed'});
 await mic.start(); mockEvent({type:'captureState',state:'paused'});
 await mic.start();
 const starts=mockRequest.mock.calls.filter(([c])=>c.op==='micStart');
 expect(starts).toHaveLength(2); expect(starts[1]![0].options).toEqual(starts[0]![0].options);
 await mic.stop(); await expect(mic.start()).rejects.toThrow('terminal');
});
it('isolates shared consumer mutation and detachment',async()=>{
 const mic=createMicrophoneCapture();let second=0;
 attachCapture(mic,a=>{a.samples[0]=9;},()=>{});
 const detach=attachCapture(mic,a=>{second=a.samples[0]!;},()=>{});
 await mic.start();mockEvent({type:'audio',sequence:1,samples:[1],sampleRate:16000});
 expect(second).toBe(1);detach();mockEvent({type:'audio',sequence:2,samples:[2],sampleRate:16000});
 expect(second).toBe(1);await mic.stop();
});
it('does not overwrite a native paused startup with recording',async()=>{
 const states:string[]=[];const mic=createMicrophoneCapture({onCaptureState:e=>states.push(e.state)});
 mockRequest.mockImplementation(async(command)=>{if(command.op==='micStart')mockEvent({type:'captureState',state:'paused'});return null;});
 await mic.start();await Promise.resolve();expect(states).toEqual(['starting','paused']);await mic.stop();
});
it('rejects late attachment rather than silently giving consumers different time origins',async()=>{
 const mic=createMicrophoneCapture();await mic.start();
 expect(()=>attachCapture(mic,()=>{},()=>{})).toThrow('before');await mic.stop();
});

it('delivers native stop-time frames before detaching an owned capture',async()=>{
 const received:number[]=[];
 const capture=await startMicrophone(a=>received.push(a.samples[0]!),()=>{});
 mockRequest.mockImplementation(async command=>command.op==='micStop'?[{sequence:1,samples:[0.5],sampleRate:16000}]:null);
 await capture.stop();expect(received).toEqual([0.5]);
});

it('defers foreground replay until pending native startup has succeeded',async()=>{
 let resolveStart!:(value:null)=>void;
 const errors:Error[]=[];const received:number[]=[];
 mockRequest.mockImplementation(command=>command.op==='micStart'
   ?new Promise(resolve=>{resolveStart=resolve;})
   :Promise.resolve(command.op==='micDrain'?[{sequence:1,samples:[0.5],sampleRate:16000}]:null));
 const mic=createMicrophoneCapture();attachCapture(mic,a=>received.push(a.samples[0]!),e=>errors.push(e));
 const starting=mic.start();mockForeground('active');
 expect(mockRequest.mock.calls.some(([command])=>command.op==='micDrain')).toBe(false);
 resolveStart(null);await starting;
 for(let i=0;i<5;i++)await Promise.resolve();
 expect(errors).toEqual([]);expect(received).toEqual([0.5]);
 await mic.stop();
});
