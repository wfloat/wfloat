package com.wfloat.bench

/** Decode before crossing the JS bridge: Long.MIN_VALUE cannot be represented exactly there. */
internal fun batteryChargeFields(raw: Long?, batteryPresent: Boolean?, failure: String? = null): Map<String, Any?> {
  val reason = when {
    failure != null -> failure
    raw == null -> "battery_service_missing"
    raw == Long.MIN_VALUE -> "unsupported_or_error"
    raw < 0 || raw > Int.MAX_VALUE.toLong() -> "invalid_charge_range"
    batteryPresent == false -> "battery_absent"
    else -> null
  }
  val validInteger = raw != null && raw in Int.MIN_VALUE.toLong()..Int.MAX_VALUE.toLong()
  return mapOf(
    "availability" to when {
      reason == null -> "available"
      failure != null || reason == "invalid_charge_range" -> "error"
      else -> "unavailable"
    },
    "reason" to reason,
    "rawPropertyValue" to raw?.toString(),
    "rawMicroampHours" to if (validInteger) raw!!.toInt() else null,
    "milliampHours" to if (reason == null) checkNotNull(raw) / 1000.0 else null
  )
}
