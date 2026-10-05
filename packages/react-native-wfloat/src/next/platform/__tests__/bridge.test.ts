const mockListeners = new Set<(event: {requestId:string;payload:string}) => void>();
const mockNative = {
  request: jest.fn(), cancel: jest.fn(),
  onEvent: jest.fn((callback: (event:{requestId:string;payload:string})=>void) => {
    mockListeners.add(callback); return {remove:()=>mockListeners.delete(callback)};
  }),
};
jest.mock('../../../NativeWfloatNext', () => ({nativeRuntime:()=>mockNative}));
import { request } from '../bridge';
import { OperationController, signalReason } from '../cancellation';

beforeEach(()=>{mockListeners.clear();jest.clearAllMocks();});
it('subscribes before dispatch and scopes replies to the request',async()=>{
 const events:unknown[]=[];
 mockNative.request.mockImplementation(async(id:string)=>{
  for(const listener of mockListeners){listener({requestId:'other',payload:'{"text":"wrong"}'});listener({requestId:id,payload:'{"text":"right"}'});}
  return '{"complete":true}';
 });
 expect(await request({op:'test'},{onEvent:event=>events.push(event)})).toEqual({complete:true});
 expect(events).toEqual([{text:'right'}]); expect(mockListeners.size).toBe(0);
});
it('waits for native cancellation cleanup and preserves SDK cancellation reasons',async()=>{
 let complete!:(value:string)=>void;
 mockNative.request.mockImplementation(()=>new Promise<string>(resolve=>{complete=resolve;}));
 const controller=new OperationController(); const reason=new Error('deleted');
 const pending=request({op:'load'},{signal:controller.signal});
 controller.abort(reason); expect(mockNative.cancel).toHaveBeenCalledTimes(1);
 expect(signalReason(controller.signal)).toBe(reason);
 const assertion=expect(pending).rejects.toBe(reason);
 complete('null');await assertion;
});
it('does not dispatch pre-aborted calls',async()=>{
 const controller=new OperationController();controller.abort();
 await expect(request({op:'load'},{signal:controller.signal})).rejects.toMatchObject({name:'AbortError'});
 expect(mockNative.request).not.toHaveBeenCalled();
});
it('detaches event listeners on malformed native replies',async()=>{
 mockNative.request.mockResolvedValue('invalid-json');
 await expect(request({op:'load'},{onEvent:()=>{}})).rejects.toThrow();
 expect(mockListeners.size).toBe(0);
});
