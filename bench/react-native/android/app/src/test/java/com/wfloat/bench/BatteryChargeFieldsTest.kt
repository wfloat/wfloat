package com.wfloat.bench

import org.junit.Assert.*
import org.junit.Test

class BatteryChargeFieldsTest {
  @Test fun remainingChargePreservesZeroOneMicroampHourAndIntegerLimit() {
    for (raw in listOf(0L, 1L, 1234567L, Int.MAX_VALUE.toLong())) {
      val sample = batteryChargeFields(raw, true)
      assertEquals("available", sample["availability"])
      assertEquals(raw.toString(), sample["rawPropertyValue"])
      assertEquals(raw.toInt(), sample["rawMicroampHours"])
      assertEquals(raw / 1000.0, sample["milliampHours"])
    }
  }
  @Test fun sentinelAndFailuresNeverBecomeZeroCharge() {
    val sentinel = batteryChargeFields(Long.MIN_VALUE, true)
    assertEquals("unavailable", sentinel["availability"])
    assertEquals("unsupported_or_error", sentinel["reason"])
    assertEquals("-9223372036854775808", sentinel["rawPropertyValue"])
    assertNull(sentinel["rawMicroampHours"])
    assertNull(sentinel["milliampHours"])
    assertEquals("battery_service_missing", batteryChargeFields(null, true)["reason"])
    val failure = batteryChargeFields(null, true, "query_failed:SecurityException")
    assertEquals("error", failure["availability"])
    assertNull(failure["milliampHours"])
  }
  @Test fun invalidOrAbsentBatteryKeepsRawEvidenceWithoutPublishingCharge() {
    for (raw in listOf(-1L, Int.MIN_VALUE.toLong(), Int.MAX_VALUE.toLong() + 1, Long.MAX_VALUE)) {
      val row = batteryChargeFields(raw, true)
      assertEquals("invalid_charge_range", row["reason"])
      assertEquals("error", row["availability"])
      assertEquals(raw.toString(), row["rawPropertyValue"])
      assertNull(row["milliampHours"])
    }
    val absent = batteryChargeFields(1234567, false)
    assertEquals("battery_absent", absent["reason"])
    assertEquals(1234567, absent["rawMicroampHours"])
    assertNull(absent["milliampHours"])
    assertEquals("available", batteryChargeFields(1234567, null)["availability"])
  }
}
