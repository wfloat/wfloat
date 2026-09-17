package com.wfloat.bench

/** Serializes callers and retains the original sample until the OS may be queried again. */
internal class HeadroomCadence<T : Any>(private val intervalMs: Long = 10_000) {
  private var sample: T? = null
  private var eligibleAtMs = 0L

  @Synchronized
  fun read(clock: () -> Long, query: () -> T): Pair<T, Long> {
    if (sample == null || clock() >= eligibleAtMs) {
      sample = query()
      // Count from completion, including failed/unavailable readings returned by query.
      eligibleAtMs = clock() + intervalMs
    }
    return Pair(checkNotNull(sample), (eligibleAtMs - clock()).coerceAtLeast(0))
  }
}
