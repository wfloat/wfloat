const mockRequest=jest.fn();
jest.mock('../../platform/bridge',()=>({
 request:(...args:unknown[])=>mockRequest(...args),
 checkAbort:(signal?:AbortSignal)=>{if(signal?.aborted){const {signalReason}=require('../../platform/cancellation');throw signalReason(signal)??Object.assign(new Error('Aborted'),{name:'AbortError'});}},
 notify:(callback:((event:unknown)=>void)|undefined,event:unknown)=>callback?.(event),
}));
import {downloadModel,deleteModelAssets,modelManifest} from '../index';
import {Sha256} from '../sha256';
import {OperationController} from '../../platform/cancellation';

beforeEach(()=>jest.clearAllMocks());
it('URL keys use known SHA-256',()=>{
 expect(new Sha256().update(Uint8Array.from([97,98,99])).digest()).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});
it('cached assets emit checking/ready and never a fake download',async()=>{
 mockRequest.mockImplementation(async(command)=>({path:'/model',sizeBytes:command.sizeBytes}));
 const phases:string[]=[];
 await downloadModel('snakers4/silero-vad',{onProgress:event=>phases.push(event.phase)});
 expect(phases).toEqual(['checking','ready']);
 expect(mockRequest.mock.calls.every(([command])=>command.op==='assetStat')).toBe(true);
});
it('one cancelling caller does not cancel a shared transfer',async()=>{
 let complete!:(value:{path:string})=>void;let nativeSignal:AbortSignal|undefined;
 mockRequest.mockImplementation((command,options)=>{
  if(command.op==='assetStat')return Promise.resolve(null);
  nativeSignal=options.signal;return new Promise(resolve=>{complete=resolve;});
 });
 const first=new OperationController();
 const results=Promise.allSettled([downloadModel('snakers4/silero-vad',{signal:first.signal}),downloadModel('snakers4/silero-vad')]);
 for(let i=0;i<10;i++)await Promise.resolve();
 first.abort();await Promise.resolve();expect(nativeSignal?.aborted).toBe(false);
 complete({path:'/model'});
 const values=await results;expect(values[0]!.status).toBe('rejected');expect(values[1]!.status).toBe('fulfilled');
 expect(mockRequest.mock.calls.filter(([command])=>command.op==='assetDownload')).toHaveLength(1);
});
it('deletion keeps shared runtime assets',async()=>{
 mockRequest.mockResolvedValue(null);
 await deleteModelAssets('wfloat/wfloat-tts');
 const shared=modelManifest('wfloat/wfloat-tts').assets.filter(asset=>asset.shared).map(asset=>asset.key);
 expect(mockRequest.mock.calls.every(([command])=>!shared.includes(command.key))).toBe(true);
});
it('ready callback can start a new load without previous cleanup unregistering it',async()=>{
 let second:Promise<void>|undefined;
 let finishStat!:(value:unknown)=>void;
 let first=true;
 mockRequest.mockImplementation(async(command)=>{
  if(command.op==='assetStat')return first?{path:'/model',sizeBytes:command.sizeBytes}:new Promise(resolve=>{finishStat=resolve;});
  return null;
 });
 await downloadModel('snakers4/silero-vad',{onProgress:event=>{
  if(event.phase==='ready'){first=false;second=downloadModel('snakers4/silero-vad');void second.catch(()=>{});}
 }});
 await deleteModelAssets('snakers4/silero-vad');
 finishStat(null);
 await expect(second).rejects.toMatchObject({name:'ModelAssetsDeletedError'});
});
