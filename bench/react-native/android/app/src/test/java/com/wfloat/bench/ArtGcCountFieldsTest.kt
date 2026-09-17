package com.wfloat.bench

import org.junit.Assert.*
import org.junit.Test

class ArtGcCountFieldsTest {
  @Test fun canonicalCountsStayExact() {
    for (raw in listOf("0", "1", "321", "9007199254740991")) {
      val row = artGcCountFields(raw)
      assertEquals(raw, row["rawCount"]); assertEquals(raw.toDouble(), row["count"]); assertNull(row["error"])
      assertEquals("collections", row["unit"]); assertEquals("ART", row["runtime"])
      assertEquals("process_lifetime", row["scope"]); assertEquals(true, row["approximate"])
    }
  }
  @Test fun invalidStringsRetainVerbatimEvidence() {
    for (raw in listOf("", "-1", "-0", "+1", "01", " 1", "1\n", "1.5", "NaN", "unavailable")) {
      val row = artGcCountFields(raw)
      assertEquals(raw, row["rawCount"]); assertNull(row["count"]); assertNotNull(row["error"])
    }
  }
  @Test fun largeStringsDoNotOverflowOrRound() {
    for (raw in listOf("9007199254740992", "9223372036854775808", "18446744073709551616")) {
      val row = artGcCountFields(raw)
      assertEquals(raw, row["rawCount"]); assertNull(row["count"]); assertNotNull(row["error"])
    }
  }
  @Test fun missingStatAndQueryFailureStayIndependent() {
    val missing = readArtGcCount { null }
    assertNull(missing["rawCount"]); assertNull(missing["count"]); assertNotNull(missing["error"])
    val failed = readArtGcCount { throw IllegalStateException("test") }
    assertNull(failed["rawCount"]); assertNull(failed["count"])
    assertEquals("ART garbage-collection query failed: IllegalStateException", failed["error"])
    assertEquals(0.0, readArtGcCount { "0" }["count"])
  }
}
