package com.wfloat.bench

import org.junit.Assert.*
import org.junit.Test

class NativeHeapSizeFieldsTest {
  @Test fun zeroAndSafeIntegersRemainExact() {
    for (raw in listOf(0L, 1L, 16777216L, 9007199254740991L)) {
      val row = nativeHeapSizeFields(raw)
      assertEquals(raw.toString(), row["rawBytes"])
      assertEquals(raw.toDouble(), row["bytes"])
      assertNull(row["error"])
    }
  }
  @Test fun invalidSignedAndUnsafeValuesRetainEvidence() {
    for (raw in listOf(-1L, Long.MIN_VALUE, 9007199254740992L, Long.MAX_VALUE)) {
      val row = nativeHeapSizeFields(raw)
      assertEquals(raw.toString(), row["rawBytes"])
      assertNull(row["bytes"])
      assertNotNull(row["error"])
    }
  }
  @Test fun queryFailureDoesNotBecomeZero() {
    val row = nativeHeapSizeFields(null, "query failed")
    assertNull(row["rawBytes"]); assertNull(row["bytes"])
    assertEquals("query failed", row["error"])
    assertNotNull(nativeHeapSizeFields(null)["error"])
  }
  @Test fun readerFailureIsUnavailable() {
    val row = readNativeHeapSize { throw IllegalStateException("test") }
    assertNull(row["bytes"]); assertNull(row["rawBytes"])
    assertEquals("Native heap size query failed: IllegalStateException", row["error"])
    assertEquals(0.0, readNativeHeapSize { 0L }["bytes"])
  }
}
