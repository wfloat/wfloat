package com.wfloat.bench

/** Pure decoding preserves zero/negative temperatures and never defaults a missing extra to zero. */
internal fun batteryTemperatureFields(
  hasTemperature: Boolean, temperature: Any?, present: Any?, status: Any?, plugged: Any?
): Map<String, Any?> {
  val batteryPresent = present as? Boolean
  val raw = temperature as? Int
  val reason = when {
    batteryPresent == false -> "battery_absent"
    !hasTemperature -> "temperature_missing"
    raw == null -> "invalid_temperature_type"
    else -> null
  }
  return mapOf(
    "availability" to when (reason) {
      null -> "available"
      "invalid_temperature_type" -> "error"
      else -> "unavailable"
    },
    "reason" to reason,
    "rawTenthsCelsius" to raw,
    "celsius" to if (reason == null) checkNotNull(raw) / 10.0 else null,
    "batteryPresent" to batteryPresent,
    "statusRaw" to (status as? Int),
    "pluggedRaw" to (plugged as? Int)
  )
}
