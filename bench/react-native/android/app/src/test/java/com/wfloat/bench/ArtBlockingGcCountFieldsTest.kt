package com.wfloat.bench

import org.junit.Assert.*
import org.junit.Test

class ArtBlockingGcCountFieldsTest {
  @Test fun canonicalCountsStayExact() {
    for (raw in listOf("0", "1", "321", "9007199254740991")) {
      val row = artBlockingGcCountFields(raw)
      assertEquals(raw, row["rawCount"]); assertEquals(raw.toDouble(), row["count"]); assertNull(row["error"])
      assertEquals("collections", row["unit"]); assertEquals("ART", row["runtime"])
      assertEquals("art_blocking_collection", row["classification"]); assertEquals("process_lifetime", row["scope"]); assertEquals(true, row["approximate"])
    }
  }
  @Test fun invalidStringsRetainVerbatimEvidence() {
    for (raw in listOf("", "-1", "-0", "+1", "01", " 1", "1\n", "1.5", "NaN", "unavailable")) {
      val row = artBlockingGcCountFields(raw)
      assertEquals(raw, row["rawCount"]); assertNull(row["count"]); assertNotNull(row["error"])
    }
  }
  @Test fun largeStringsDoNotOverflowOrRound() {
    for (raw in listOf("9007199254740992", "9223372036854775808", "18446744073709551616")) {
      val row = artBlockingGcCountFields(raw)
      assertEquals(raw, row["rawCount"]); assertNull(row["count"]); assertNotNull(row["error"])
    }
  }
  @Test fun missingStatAndQueryFailureStayIndependent() {
    val missing = readArtBlockingGcCount { null }
    assertNull(missing["rawCount"]); assertNull(missing["count"]); assertNotNull(missing["error"])
    val failed = readArtBlockingGcCount { throw IllegalStateException("test") }
    assertNull(failed["rawCount"]); assertNull(failed["count"])
    assertEquals("ART blocking garbage-collection query failed: IllegalStateException", failed["error"])
    assertEquals(0.0, readArtBlockingGcCount { "0" }["count"])
  }
}
