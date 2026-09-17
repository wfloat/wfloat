package com.wfloat.bench

import org.junit.Assert.*
import org.junit.Test

class BatteryCurrentFieldsTest {
  @Test fun preservesSignedCurrentAndRealZero() {
    for (raw in listOf(123456L, -123456L, 0L, 1L, -1L)) {
      val sample = batteryCurrentFields(raw, true)
      assertEquals("available", sample["availability"])
      assertEquals(raw.toString(), sample["rawPropertyValue"])
      assertEquals(raw.toInt(), sample["rawMicroamps"])
      assertEquals(raw / 1000.0, sample["milliamps"])
    }
  }
  @Test fun sentinelMissingServiceAndThrownErrorNeverBecomeZero() {
    val unavailable = batteryCurrentFields(Long.MIN_VALUE, true)
    assertEquals("unsupported_or_error", unavailable["reason"])
    assertEquals("-9223372036854775808", unavailable["rawPropertyValue"])
    assertNull(unavailable["rawMicroamps"])
    assertNull(unavailable["milliamps"])
    assertEquals("battery_service_missing", batteryCurrentFields(null, true)["reason"])
    val error = batteryCurrentFields(null, true, "query_failed:SecurityException")
    assertEquals("error", error["availability"])
    assertNull(error["milliamps"])
  }
  @Test fun invalidRangeAndAbsentBatteryKeepEvidenceWithoutClaimingAValue() {
    assertEquals("invalid_current_range", batteryCurrentFields(Long.MAX_VALUE, true)["reason"])
    val absent = batteryCurrentFields(-1000L, false)
    assertEquals("battery_absent", absent["reason"])
    assertEquals(-1000, absent["rawMicroamps"])
    assertNull(absent["milliamps"])
    assertEquals("available", batteryCurrentFields(0L, null)["availability"])
  }

}
