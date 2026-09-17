package com.wfloat.bench

import org.junit.Assert.*
import org.junit.Test

class PowerMonitorFieldsTest {
  @Test fun zeroIsEnergyAndNotMissing() {
    val result = powerMonitorFields(0, 100, 125)
    assertEquals("available", result["availability"])
    assertEquals(0.0, result["joules"])
    assertEquals(25.0, result["snapshotAgeAtReadMs"])
  }
  @Test fun unavailableAndMalformedNeverBecomeNumericReadings() {
    for ((energy, time, reason) in listOf(Triple(-1L, 0L, "energy_unavailable"),
        Triple(-2L, 100L, "invalid_energy"), Triple(100L, -1L, "invalid_timestamp"), Triple(100L, 201L, "invalid_timestamp"))) {
      val result = powerMonitorFields(energy, time, 200)
      assertEquals(reason, result["reason"])
      assertNull(result["joules"])
      assertNull(result["snapshotAgeAtReadMs"])
      assertEquals(energy.toString(), result["rawEnergyUws"])
      assertEquals(time.toString(), result["rawSnapshotUptimeMs"])
    }
  }
  @Test fun longEnergyKeepsPrecisionInRawEvidence() {
    val result = powerMonitorFields(Long.MAX_VALUE, 100, 200)
    assertEquals("9223372036854775807", result["rawEnergyUws"])
    assertEquals("available", result["availability"])
    assertEquals(1.5, powerMonitorFields(1500000, 100, 200)["joules"])
  }
}
