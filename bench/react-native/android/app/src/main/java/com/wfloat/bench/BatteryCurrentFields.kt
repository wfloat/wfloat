package com.wfloat.bench

/** Decode before crossing the JS bridge: Long.MIN_VALUE cannot be represented exactly there. */
internal fun batteryCurrentFields(raw: Long?, batteryPresent: Boolean?, failure: String? = null): Map<String, Any?> {
  val reason = when {
    failure != null -> failure
    raw == null -> "battery_service_missing"
    raw == Long.MIN_VALUE -> "unsupported_or_error"
    raw < Int.MIN_VALUE.toLong() || raw > Int.MAX_VALUE.toLong() -> "invalid_current_range"
    batteryPresent == false -> "battery_absent"
    else -> null
  }
  val validInteger = raw != null && raw in Int.MIN_VALUE.toLong()..Int.MAX_VALUE.toLong()
  return mapOf(
    "availability" to when {
      reason == null -> "available"
      failure != null || reason == "invalid_current_range" -> "error"
      else -> "unavailable"
    },
    "reason" to reason,
    "rawPropertyValue" to raw?.toString(),
    // Name follows Android's declared unit; some Samsung firmware disagrees. See battery-current-units.md.
    "rawMicroamps" to if (validInteger) raw!!.toInt() else null,
    "milliamps" to if (reason == null) checkNotNull(raw) / 1000.0 else null
  )
}
