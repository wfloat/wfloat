package com.wfloat.bench

// Android's ENERGY_UNAVAILABLE sentinel is -1. Preserve every raw long exactly
// before crossing the double-only React Native bridge.
internal fun powerMonitorFields(energy: Long, snapshotMs: Long, completedMs: Long): Map<String, Any?> {
  val reason = when {
    energy == -1L -> "energy_unavailable"
    energy < 0 -> "invalid_energy"
    snapshotMs < 0 || snapshotMs > completedMs -> "invalid_timestamp"
    else -> null
  }
  return mapOf(
    "availability" to if (reason == null) "available" else if (energy == -1L) "unavailable" else "error",
    "reason" to reason, "rawEnergyUws" to energy.toString(),
    "rawSnapshotUptimeMs" to snapshotMs.toString(),
    "joules" to if (reason == null) energy.toDouble() / 1_000_000 else null,
    "snapshotAgeAtReadMs" to if (reason == null) (completedMs - snapshotMs).toDouble() else null
  )
}
