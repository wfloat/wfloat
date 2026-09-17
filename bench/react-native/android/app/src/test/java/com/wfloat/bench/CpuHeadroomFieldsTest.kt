package com.wfloat.bench

import org.junit.Assert.*
import org.junit.Test
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

class CpuHeadroomFieldsTest {
  @Test fun preservesZeroAndFullScaleWithoutInvertingTheMetric() {
    for (value in listOf(0f, 50.12345f, 100f)) {
      val fields = cpuHeadroomFields(value)
      assertEquals("available", fields["availability"])
      assertEquals(value.toDouble(), fields["value"])
      assertEquals(value.toString(), fields["rawValue"])
      assertNull(fields["reason"])
    }
  }

  @Test fun nanIsTemporaryButInvalidNumbersAreErrorsAndNeverBecomeZero() {
    for (value in listOf(Float.NaN, Float.POSITIVE_INFINITY, Float.NEGATIVE_INFINITY, -1f, 101f)) {
      val fields = cpuHeadroomFields(value)
      assertEquals(if (value.isNaN()) "unavailable" else "error", fields["availability"])
      assertNull(fields["value"])
      assertEquals(value.toString(), fields["rawValue"])
    }
    assertEquals("temporarily_unavailable", cpuHeadroomFields(Float.NaN)["reason"])
  }

  @Test fun deviceCadenceIncludesQueryTimeAndRetainsIdentityAcrossRemounts() {
    var now = 100L
    var queries = 0
    val cache = CpuHeadroomCadence<Map<String, Any?>>()
    val query = { queries++; now += 25; Pair(cpuHeadroomFields(Float.NaN), 12_000L) }
    val first = cache.read({ now }, query)
    assertEquals(12_000L, first.second)
    now = 12_124
    val cached = cache.read({ now }, query)
    assertSame(first.first, cached.first)
    assertEquals(1L, cached.second)
    assertEquals(1, queries)
    now = 12_125
    cache.read({ now }) { queries++; Pair(cpuHeadroomFields(0f), 2000L) }
    assertEquals(2, queries)
    now = 14_124
    assertEquals(1L, cache.read({ now }, query).second)
  }

  @Test fun unsupportedSupportCheckIsNotRepeatedOnResumeOrRemount() {
    var now = 0L
    var queries = 0
    val cache = CpuHeadroomCadence<String>()
    val query = { queries++; Pair("unsupported", null) }
    val first = cache.read({ now }, query)
    now = 1_000_000
    assertEquals(first, cache.read({ now }, query))
    assertNull(first.second)
    assertEquals(1, queries)
  }

  @Test fun concurrentBridgeRequestsCannotBypassTheMinimumInterval() {
    val cache = CpuHeadroomCadence<String>()
    val pool = Executors.newFixedThreadPool(4)
    val start = CountDownLatch(1)
    var queries = 0
    try {
      val results = (1..12).map {
        pool.submit<String> {
          start.await()
          cache.read({ 50L }) { queries++; Pair("sample", 5000L) }.first
        }
      }
      start.countDown()
      results.forEach { assertEquals("sample", it.get(5, TimeUnit.SECONDS)) }
      assertEquals(1, queries)
    } finally { pool.shutdownNow() }
  }
}
