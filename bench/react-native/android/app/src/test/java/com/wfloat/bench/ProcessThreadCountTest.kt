package com.wfloat.bench

import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class ProcessThreadCountTest {
  @Test fun readsProcessFieldWithWhitespace() {
    assertEquals(48, ProcessThreadCount.parse("Name:\tapp\nThreads:\t48 \nVmRSS:\t1234 kB\n"))
    assertEquals(1, ProcessThreadCount.parse("Threads: 1"))
  }
  @Test fun rejectsMissingDuplicateAndInvalidFields() {
    for (text in listOf("", "OtherThreads: 42", "Threads: 1\nThreads: 2", "Threads: 0",
      "Threads: -1", "Threads: 1.5", "Threads: 42 threads", "Threads:", "Threads: 2147483648")) {
      assertThrows(text, IllegalArgumentException::class.java) { ProcessThreadCount.parse(text) }
    }
  }
}
