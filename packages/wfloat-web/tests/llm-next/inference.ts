import { defineTool } from '../../src/llm-next/tools.js';
import { LanguageModel } from '../../src/llm-next/model.js';
import type { ZodSchema } from '../../src/schema/types.js';
declare const model: LanguageModel;
declare const transformed: ZodSchema<{value:string}, {value:number}>;
const tool = defineTool({ inputSchema: transformed, execute({value}) {
  const correct: number = value;
  // @ts-expect-error transform output is number, not string
  const wrong: string = value;
  return {value:correct};
}});
const generation = model.generate([], {tools:{convert:tool}, onToolCall({call}) {
  const correct: number = call.arguments.value;
  // @ts-expect-error transformed callback arguments are not raw strings
  const wrong: string = call.arguments.value;
}});
const calls = (await generation.result()).toolCalls;
const n: number = calls[0].arguments.value;
const weather = defineTool({inputSchema:{type:'object',properties:{city:{type:'string'}},required:['city']},execute({city}) {
  const correct: string = city;
  return {city:correct};
}});
const structured = model.generate([], {structuredOutput:{schema:transformed}});
const output = (await structured.result()).output;
if (output) { const correct: number = output.value; }
