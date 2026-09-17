package com.wfloat.bench

internal fun cpuHeadroomFields(value: Float): Map<String, Any?> {
  val valid = value.isFinite() && value >= 0 && value <= 100
  return mapOf(
    "availability" to if (valid) "available" else if (value.isNaN()) "unavailable" else "error",
    "value" to if (valid) value.toDouble() else null,
    "rawValue" to value.toString(),
    "reason" to if (valid) null else if (value.isNaN()) "temporarily_unavailable" else "invalid_value"
  )
}

/** Cache identity survives remounts; a null interval means support was rejected. */
internal class CpuHeadroomCadence<T : Any> {
  private var cached: T? = null
  private var eligibleAtMs: Long? = 0

  @Synchronized
  fun read(clock: () -> Long, query: () -> Pair<T, Long?>): Pair<T, Long?> {
    if (cached == null || eligibleAtMs?.let { clock() >= it } == true) {
      val (sample, intervalMs) = query()
      require(intervalMs == null || intervalMs in 1..Int.MAX_VALUE.toLong())
      cached = sample
      // Count from completion, including a NaN or failed query.
      eligibleAtMs = intervalMs?.let { clock() + it }
    }
    return Pair(checkNotNull(cached), eligibleAtMs?.let { (it - clock()).coerceAtLeast(0) })
  }
}
