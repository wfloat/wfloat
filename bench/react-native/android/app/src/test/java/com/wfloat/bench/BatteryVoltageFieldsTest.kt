package com.wfloat.bench

import org.junit.Assert.*
import org.junit.Test

class BatteryVoltageFieldsTest {
  @Test fun convertsMillivoltsWithoutDiscardingResolution() {
    for (raw in listOf(1, 3999, 4123, 5000, 8000)) {
      val report = batteryVoltageFields(true, raw, true)
      assertEquals("available", report["availability"])
      assertEquals(raw, report["rawMillivolts"])
      assertEquals(raw / 1000.0, report["volts"])
    }
  }
  @Test fun missingZeroMalformedAndNegativeRemainDistinct() {
    val missing = batteryVoltageFields(false, null, true)
    assertEquals("voltage_missing", missing["reason"])
    assertNull(missing["rawMillivolts"])
    val zero = batteryVoltageFields(true, 0, true)
    assertEquals("unavailable", zero["availability"])
    assertEquals("zero_voltage", zero["reason"])
    assertEquals(0, zero["rawMillivolts"])
    assertNull(zero["volts"])
    val malformed = batteryVoltageFields(true, "4123", true)
    assertEquals("invalid_voltage_type", malformed["reason"])
    assertEquals("error", malformed["availability"])
    val negative = batteryVoltageFields(true, -1, true)
    assertEquals("negative_voltage", negative["reason"])
    assertEquals(-1, negative["rawMillivolts"])
    assertNull(negative["volts"])
  }
  @Test fun absentBatteryRetainsRawEvidenceAndUnknownPresenceDoesNotSuppressVoltage() {
    val absent = batteryVoltageFields(true, 4123, false)
    assertEquals("battery_absent", absent["reason"])
    assertEquals(4123, absent["rawMillivolts"])
    assertNull(absent["volts"])
    assertEquals("available", batteryVoltageFields(true, 4123, null)["availability"])
  }
}
