package com.wfloat.bench

/** Keep missing, malformed and nonpositive reports distinct from a usable battery voltage. */
internal fun batteryVoltageFields(hasVoltage: Boolean, voltage: Any?, present: Any?): Map<String, Any?> {
  val raw = voltage as? Int
  val reason = when {
    present == false -> "battery_absent"
    !hasVoltage -> "voltage_missing"
    raw == null -> "invalid_voltage_type"
    raw < 0 -> "negative_voltage"
    raw == 0 -> "zero_voltage"
    else -> null
  }
  return mapOf(
    "availability" to when (reason) {
      null -> "available"
      "invalid_voltage_type", "negative_voltage" -> "error"
      else -> "unavailable"
    },
    "reason" to reason,
    "rawMillivolts" to raw,
    "volts" to if (reason == null) checkNotNull(raw) / 1000.0 else null
  )
}
