package com.wfloat.bench

import org.junit.Assert.*
import org.junit.Test

class JavaHeapLimitFieldsTest {
  @Test fun finiteLimitsPreserveZeroAndPrecision() {
    for (raw in listOf(0L, 67108864L, 134217728L, 9007199254740991L)) {
      val row = javaHeapLimitFields(raw)
      assertEquals("finite", row["limitKind"]); assertEquals(raw.toString(), row["rawBytes"])
      assertEquals(raw.toDouble(), row["bytes"]); assertNull(row["error"])
    }
    for (raw in listOf(9007199254740992L, Long.MAX_VALUE - 1)) {
      val row = javaHeapLimitFields(raw)
      assertEquals("finite", row["limitKind"]); assertEquals(raw.toString(), row["rawBytes"])
      assertNull(row["bytes"]); assertNotNull(row["error"])
    }
  }
  @Test fun sentinelMeansNoInherentLimitNotAnExabyteCountOrFailure() {
    val row = javaHeapLimitFields(Long.MAX_VALUE)
    assertEquals("no_inherent_limit", row["limitKind"])
    assertEquals("9223372036854775807", row["rawBytes"])
    assertNull(row["bytes"]); assertNull(row["error"])
  }
  @Test fun missingNegativeAndExceptionsRemainUnavailable() {
    for (raw in listOf(null, -1L, Long.MIN_VALUE)) {
      val row = javaHeapLimitFields(raw)
      assertEquals("unavailable", row["limitKind"]); assertNull(row["bytes"])
      assertEquals(raw?.toString(), row["rawBytes"]); assertNotNull(row["error"])
    }
    val failure = readJavaHeapLimit { throw IllegalStateException("test") }
    assertEquals("unavailable", failure["limitKind"]); assertNull(failure["rawBytes"])
    assertEquals("Java heap limit query failed: IllegalStateException", failure["error"])
  }
  @Test fun readsOnceAndUsesCurrentReportedLimit() {
    var reads = 0
    val row = readJavaHeapLimit { ++reads; 67108864L }
    assertEquals(1, reads); assertEquals(67108864.0, row["bytes"])
    assertEquals(134217728.0, readJavaHeapLimit { 134217728L }["bytes"])
  }
}
