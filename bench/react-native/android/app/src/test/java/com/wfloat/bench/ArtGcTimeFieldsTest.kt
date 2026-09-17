package com.wfloat.bench

import org.junit.Assert.*
import org.junit.Test

class ArtGcTimeFieldsTest {
  @Test fun canonicalCountsStayExact() {
    for (raw in listOf("0", "1", "321", "9007199254740991")) {
      val row = artGcTimeFields(raw)
      assertEquals(raw, row["rawMilliseconds"]); assertEquals(raw.toDouble(), row["milliseconds"]); assertNull(row["error"])
      assertEquals("milliseconds", row["unit"]); assertEquals("ART", row["runtime"])
      assertEquals("process_lifetime", row["scope"]); assertEquals(true, row["approximate"])
    }
  }
  @Test fun invalidStringsRetainVerbatimEvidence() {
    for (raw in listOf("", "-1", "-0", "+1", "01", " 1", "1\n", "1.5", "NaN", "unavailable")) {
      val row = artGcTimeFields(raw)
      assertEquals(raw, row["rawMilliseconds"]); assertNull(row["milliseconds"]); assertNotNull(row["error"])
    }
  }
  @Test fun largeStringsDoNotOverflowOrRound() {
    for (raw in listOf("9007199254740992", "9223372036854775808", "18446744073709551616")) {
      val row = artGcTimeFields(raw)
      assertEquals(raw, row["rawMilliseconds"]); assertNull(row["milliseconds"]); assertNotNull(row["error"])
    }
  }
  @Test fun missingStatAndQueryFailureStayIndependent() {
    val missing = readArtGcTime { null }
    assertNull(missing["rawMilliseconds"]); assertNull(missing["milliseconds"]); assertNotNull(missing["error"])
    val failed = readArtGcTime { throw IllegalStateException("test") }
    assertNull(failed["rawMilliseconds"]); assertNull(failed["milliseconds"])
    assertEquals("ART garbage-collection time query failed: IllegalStateException", failed["error"])
    assertEquals(0.0, readArtGcTime { "0" }["milliseconds"])
  }
}
