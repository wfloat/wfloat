package com.wfloat.bench

import org.junit.Assert.*
import org.junit.Test

class ArtFreedBytesFieldsTest {
  @Test fun canonicalBytesStayExact() {
    for (raw in listOf("0", "1", "-1", "-321", "9007199254740991", "-9007199254740991")) {
      val row = artFreedBytesFields(raw)
      assertEquals(raw, row["rawBytes"]); assertEquals(raw.toDouble(), row["bytes"]); assertNull(row["error"])
      assertEquals("bytes", row["unit"]); assertEquals("ART", row["runtime"])
      assertEquals("art_managed_bytes_freed_net", row["accounting"]); assertEquals(true, row["signed"]); assertEquals(false, row["monotonic"]); assertEquals("process_lifetime", row["scope"]); assertEquals(true, row["approximate"])
    }
  }
  @Test fun invalidStringsRetainVerbatimEvidence() {
    for (raw in listOf("", "-01", "-0", "+1", "01", " 1", "1\n", "1.5", "NaN", "unavailable")) {
      val row = artFreedBytesFields(raw)
      assertEquals(raw, row["rawBytes"]); assertNull(row["bytes"]); assertNotNull(row["error"])
    }
  }
  @Test fun largeStringsDoNotOverflowOrRound() {
    for (raw in listOf("-9007199254740992", "-9223372036854775809", "9007199254740992", "9223372036854775808", "18446744073709551616")) {
      val row = artFreedBytesFields(raw)
      assertEquals(raw, row["rawBytes"]); assertNull(row["bytes"]); assertNotNull(row["error"])
    }
  }
  @Test fun missingStatAndQueryFailureStayIndependent() {
    val missing = readArtFreedBytes { null }
    assertNull(missing["rawBytes"]); assertNull(missing["bytes"]); assertNotNull(missing["error"])
    val failed = readArtFreedBytes { throw IllegalStateException("test") }
    assertNull(failed["rawBytes"]); assertNull(failed["bytes"])
    assertEquals("ART reclaimed-byte accounting query failed: IllegalStateException", failed["error"])
    assertEquals(0.0, readArtFreedBytes { "0" }["bytes"])
  }
}
