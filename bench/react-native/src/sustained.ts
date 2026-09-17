// Keep exactly one generation in flight. Stop requests take effect between
// generations because the SDK does not currently expose LLM cancellation.
export async function repeatWorkload<T>(options: {
  generate: () => Promise<T>;
  onResult: (result: T, iterations: number) => Promise<void>;
  stopReason: () => string | null;
  durationMs: number;
  now: () => number;
}) {
  const startedAt = options.now();
  let iterations = 0;
  for (;;) {
    const elapsedMs = options.now() - startedAt;
    const reason =
      options.stopReason() ??
      (elapsedMs >= options.durationMs ? "Five-minute limit reached" : null);
    if (reason) return { reason, iterations, elapsedMs };
    const result = await options.generate();
    iterations += 1;
    await options.onResult(result, iterations);
  }
}
