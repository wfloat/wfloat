# Language model

```ts
import { loadLanguageModel, type Message } from '@wfloat/react-native-wfloat';

const model = await loadLanguageModel('HuggingFaceTB/SmolLM2-360M-Instruct');
const messages: Message[] = [{ role: 'user', content: 'Hello!' }];
const generation = model.generate(messages, {
  maxTokensPerRound: 128,
  onText: text => console.log(text),
});
const result = await generation.result();
console.log(result.text, result.stopReason);
await model.unload();
```

## `generate(messages, options?)`

Returns a handle immediately. `result()` resolves to the result; `finished` signals completion without returning it. `cancel()` stops cooperatively and resolves with `stopReason: "cancelled"`. There is no pause/resume API. Actual failures reject with `GenerationError`, including `partialResult` and `cause`.

`onText` receives answer-text fragments; `onReasoning` receives reasoning separately. Both may span multiple rounds. `onRoundStart({ roundIndex })` identifies a new round. Callbacks notify; they do not hold up inference or tool execution.

| Option | Meaning |
| --- | --- |
| `maxRounds` | Maximum model rounds; default 20. |
| `maxTokensPerRound` | Output-token cap per round, including reasoning. |
| `reasoning` | Enable/disable reasoning where the model supports it. |
| `stopStrings` | Stop on matching answer text; omit the match from output. |
| `stopWhen` | After a round, inspect `messages`, `rounds`, and `latestRound` to prevent another round. |
| `temperature`, `topP`, `topK`, `minP`, `repetitionPenalty`, `presencePenalty`, `frequencyPenalty`, `seed` | Sampling overrides; omitted settings use model/runtime defaults. |

The result contains `text` from the latest round, `newMessages` to append to your history, `rounds`, `stopReason`, `usage` (`inputTokens`, `outputTokens`), and `durationMs`. Text is not necessarily a final answer: inspect the stop reason. Other reasons include `complete`, `toolCalls`, `maxRounds`, `stopCondition`, `maxTokens`, `contextLimit`, and `stopString`.

## Tools

```ts
import { defineTool } from '@wfloat/react-native-wfloat';

const clock = defineTool({
  description: 'Read the current time.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  execute: () => ({ time: new Date().toISOString() }),
});
// With the loaded model and input messages:
const result = await model.generate(messages, { tools: { clock } }).result();
```

All tools must define `execute`, or all must omit it for manual handling. Executors receive validated arguments and `{ signal, callId, roundIndex }`; return JSON-compatible values. JSON Schema and supported Zod schemas are accepted; install Zod yourself if using it.

Defaults: `toolExecution: "sequential"`, `toolExecutionTiming: "immediate"`, and `toolErrorBehavior: "continue"`. Use `"parallel"` with optional `maxConcurrentTools`, `"afterGeneration"` to defer execution, or `"stop"` to fail on executor errors. Wfloat does not retry executors automatically.

Notifications: `onToolCall`, `onToolStart`, `onToolResult`, `onToolError`, `onToolCancel`, and `onToolValidationError`. Manual tools appear in `result.toolCalls`; append `result.newMessages`, then messages made with `toolResult(call, output)`, before generating again. Calls observed early through `onToolCall` must not execute a second time when they appear in the result.

```ts
import { toolResult } from '@wfloat/react-native-wfloat';

const manualClock = defineTool({ inputSchema: clock.inputSchema });
const turn = await model.generate(messages, { tools: { clock: manualClock } }).result();
messages.push(...turn.newMessages);
for (const call of turn.toolCalls) {
  messages.push(toolResult(call, { time: new Date().toISOString() }));
}
// Pass the updated messages to the next generate() call.
```

## `structuredOutput`

```ts
const result = await model.generate(messages, {
  structuredOutput: {
    schema: { type: 'object', properties: { ok: { type: 'boolean' } },
      required: ['ok'], additionalProperties: false },
    maxCorrectionAttempts: 0,
  },
}).result();
console.log(result.output);
```

Constrains the answer to the supported JSON Schema subset and validates it, including supplied Zod validation. Tools cannot be combined with structured output. Correction attempts default to zero and consume the `maxRounds` budget. Exhausted validation rejects; an expected early stop can return without validated `output`. Stream consumers can reset their display at `onRoundStart` when corrections occur.

## Context and ownership

`loadLanguageModel(id, { contextSize })` sets capacity (default 2048). `await model.countInputTokens(messages, options?)` counts the formatted request; pass the same `tools`, `reasoning`, or `structuredOutput` settings. `model.contextSize` exposes capacity. Wfloat does not silently compact history; a context-limit stop includes `contextLimit` details.

Whole operations queue on one instance, including tool waits. An executor must not await another generation on the same model: that work would wait behind its own caller.
