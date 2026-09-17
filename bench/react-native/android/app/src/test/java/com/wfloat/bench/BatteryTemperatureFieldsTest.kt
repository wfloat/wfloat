package com.wfloat.bench

import org.junit.Assert.*
import org.junit.Test

class BatteryTemperatureFieldsTest {
  @Test fun convertsTenthsAndPreservesZeroAndNegativeTemperatures() {
    for (raw in listOf(327, 0, -123)) {
      val report = batteryTemperatureFields(true, raw, true, 2, 1)
      assertEquals("available", report["availability"])
      assertEquals(raw, report["rawTenthsCelsius"])
      assertEquals(raw / 10.0, report["celsius"])
      assertEquals(2, report["statusRaw"])
      assertEquals(1, report["pluggedRaw"])
    }
  }

  @Test fun missingAndWrongTypeNeverBecomeZero() {
    val missing = batteryTemperatureFields(false, null, true, null, null)
    assertEquals("unavailable", missing["availability"])
    assertEquals("temperature_missing", missing["reason"])
    assertNull(missing["celsius"])
    val malformed = batteryTemperatureFields(true, "327", true, "charging", null)
    assertEquals("error", malformed["availability"])
    assertNull(malformed["celsius"])
    assertNull(malformed["statusRaw"])
  }

  @Test fun absentBatteryPreservesRawEvidenceButDoesNotClaimATemperature() {
    val report = batteryTemperatureFields(true, 250, false, 1, 0)
    assertEquals("battery_absent", report["reason"])
    assertEquals(250, report["rawTenthsCelsius"])
    assertNull(report["celsius"])
    // A missing presence flag is unknown, not proof of absence.
    val unknown = batteryTemperatureFields(true, 250, null, null, null)
    assertEquals("available", unknown["availability"])
    assertNull(unknown["batteryPresent"])
  }
}
