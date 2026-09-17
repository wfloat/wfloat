package com.wfloat.bench

import org.junit.Assert.*
import org.junit.Test

class ArtAllocatedBytesFieldsTest {
  @Test fun canonicalBytesStayExact() {
    for (raw in listOf("0", "1", "321", "9007199254740991")) {
      val row = artAllocatedBytesFields(raw)
      assertEquals(raw, row["rawBytes"]); assertEquals(raw.toDouble(), row["bytes"]); assertNull(row["error"])
      assertEquals("bytes", row["unit"]); assertEquals("ART", row["runtime"])
      assertEquals("art_managed_bytes_allocated_ever", row["accounting"]); assertEquals("process_lifetime", row["scope"]); assertEquals(true, row["approximate"])
    }
  }
  @Test fun invalidStringsRetainVerbatimEvidence() {
    for (raw in listOf("", "-1", "-0", "+1", "01", " 1", "1\n", "1.5", "NaN", "unavailable")) {
      val row = artAllocatedBytesFields(raw)
      assertEquals(raw, row["rawBytes"]); assertNull(row["bytes"]); assertNotNull(row["error"])
    }
  }
  @Test fun largeStringsDoNotOverflowOrRound() {
    for (raw in listOf("9007199254740992", "9223372036854775808", "18446744073709551616")) {
      val row = artAllocatedBytesFields(raw)
      assertEquals(raw, row["rawBytes"]); assertNull(row["bytes"]); assertNotNull(row["error"])
    }
  }
  @Test fun missingStatAndQueryFailureStayIndependent() {
    val missing = readArtAllocatedBytes { null }
    assertNull(missing["rawBytes"]); assertNull(missing["bytes"]); assertNotNull(missing["error"])
    val failed = readArtAllocatedBytes { throw IllegalStateException("test") }
    assertNull(failed["rawBytes"]); assertNull(failed["bytes"])
    assertEquals("ART cumulative allocated bytes query failed: IllegalStateException", failed["error"])
    assertEquals(0.0, readArtAllocatedBytes { "0" }["bytes"])
  }
}
