package com.wfloat.bench

import org.junit.Assert.*
import org.junit.Test

class JavaHeapUsedFieldsTest {
  @Test fun subtractsBeforeConversionAndPreservesZero() {
    for ((total, free, expected) in listOf(Triple(0L, 0L, 0L), Triple(100L, 40L, 60L),
        Triple(Long.MAX_VALUE, Long.MAX_VALUE - 7, 7L), Triple(9007199254740991L, 0L, 9007199254740991L))) {
      val row = javaHeapUsedFields(total, free, total)
      assertEquals(expected.toString(), row["rawBytes"]); assertEquals(expected.toDouble(), row["bytes"])
      assertNull(row["error"]); assertEquals(total.toString(), row["rawTotalBeforeBytes"])
    }
    val large = javaHeapUsedFields(Long.MAX_VALUE, 0L, Long.MAX_VALUE)
    assertEquals(Long.MAX_VALUE.toString(), large["rawBytes"]); assertNull(large["bytes"]); assertNotNull(large["error"])
  }
  @Test fun rejectsChangedCapacityImpossibleInputsAndMissingData() {
    for ((before, free, after) in listOf(Triple(100L, 40L, 101L), Triple(100L, 101L, 100L),
      Triple(-1L, 0L, -1L), Triple(100L, -1L, 100L))) {
      val row = javaHeapUsedFields(before, free, after)
      assertNull(row["bytes"]); assertNull(row["rawBytes"]); assertNotNull(row["error"])
      assertEquals(free.toString(), row["rawFreeBytes"])
    }
    assertNull(javaHeapUsedFields(null, null, null)["bytes"])
  }
  @Test fun readsTotalFreeTotalWithoutRetryingChangingCapacity() {
    val calls = mutableListOf<String>(); var totals = 0
    val row = readJavaHeapUsed({ calls.add("total"); if (++totals == 1) 100L else 101L }, { calls.add("free"); 40L })
    assertEquals(listOf("total", "free", "total"), calls)
    assertEquals("Java heap size changed during the read", row["error"])
    assertEquals("100", row["rawTotalBeforeBytes"]); assertEquals("101", row["rawTotalAfterBytes"])
  }
  @Test fun exceptionPreservesPartialInputsWithoutManufacturingZero() {
    val row = readJavaHeapUsed({ 100L }, { throw IllegalStateException("test") })
    assertEquals("100", row["rawTotalBeforeBytes"]); assertNull(row["rawFreeBytes"])
    assertNull(row["rawTotalAfterBytes"]); assertNull(row["rawBytes"]); assertNull(row["bytes"])
    assertEquals("Java heap query failed: IllegalStateException", row["error"])
  }
}
