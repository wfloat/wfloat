// SPDX-License-Identifier: MIT
// Integration type audit; run with --module ESNext --moduleResolution bundler.
import { defineTool } from '../../packages/wfloat-web/src/llm-next/tools.js';
import type { LanguageModel } from '../../packages/wfloat-web/src/llm-next/model.js';
import type { ToolGenerationOptions } from '../../packages/wfloat-web/src/llm-next/types.js';
import type { ZodSchema } from '../../packages/wfloat-web/src/schema/types.js';

declare const transformed: ZodSchema<{ quantity: string }, { quantity: number }>;
declare const model: LanguageModel;
const order = defineTool({ inputSchema: transformed, execute: ({ quantity }) => ({ total: quantity * 10 }) });
const city = defineTool({ inputSchema: {type:'object',properties:{city:{type:'string'}},required:['city']} as const, execute: args => ({city:args.city}) });
// @ts-expect-error cannot reinterpret parsed quantity as a string
const bad = defineTool({inputSchema:transformed,execute:(args:{quantity:string})=>args.quantity});
const tools = {order,city};
const options: ToolGenerationOptions<typeof tools> = {
  tools,
  onToolCall: ({call}) => {
    if(call.name==='order') { const n:number=call.arguments.quantity; void n; }
    if(call.name==='city') { const s:string=call.arguments.city; void s; }
  },
};
model.generate([],options).result().then(r=>r.toolCalls.forEach(call=>{
  if(call.name==='order') { const n:number=call.arguments.quantity; void n; }
}));
model.generate([],{structuredOutput:{schema:transformed}}).result().then(r=>{
  if(r.output) { const n:number=r.output.quantity; void n; }
});
model.generate([],{tools,onToolCall:({call})=>{
  if(call.name==='order') { const n:number=call.arguments.quantity; void n; }
}});
model.generate([], {tools:{order}, onToolResult:({output})=>{
  const n:number=output.total; void n;
}});
// Executor return types must survive defineTool for downstream event typing.
type OrderOutput = Awaited<ReturnType<NonNullable<typeof order.execute>>>;
declare const orderOutput: OrderOutput;
const total:number = orderOutput.total;
void total; void bad;
