package com.wfloat.bench

import org.junit.Assert.*
import org.junit.Test
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

class HeadroomCadenceTest {
  @Test fun preservesSampleAndWaitsFromQueryCompletion() {
    var now = 50L
    var queries = 0
    val cadence = HeadroomCadence<Pair<Int, Long>>()
    val query = { ++queries; val timestamp = now; now += 25; Pair(queries, timestamp) }
    val first = cadence.read({ now }, query)
    assertEquals(10_000L, first.second)
    now = 10_074
    val cached = cadence.read({ now }, query)
    assertSame(first.first, cached.first)
    assertEquals(1L, cached.second)
    assertEquals(1, queries)
    now = 10_075
    assertEquals(Pair(2, 10_075L), cadence.read({ now }, query).first)
    assertEquals(2, queries)
  }

  @Test fun concurrentCallersShareOneUnavailableSample() {
    val cadence = HeadroomCadence<String>()
    val pool = Executors.newFixedThreadPool(8)
    val start = CountDownLatch(1)
    var queries = 0
    try {
      val results = (1..16).map {
        pool.submit<String> {
          start.await()
          cadence.read({ 1L }) { queries++; "not_reported" }.first
        }
      }
      start.countDown()
      results.forEach { assertEquals("not_reported", it.get(5, TimeUnit.SECONDS)) }
      assertEquals(1, queries)
    } finally { pool.shutdownNow() }
  }
}
