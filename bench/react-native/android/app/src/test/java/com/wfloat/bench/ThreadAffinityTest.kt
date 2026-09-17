package com.wfloat.bench

import org.junit.Assert.*
import org.junit.Test

class ThreadAffinityTest {
  private fun stat(start: String): String {
    val f=MutableList(39){"0"};f[0]="S";f[19]=start
    return "42 (a ) tricky ( name\n) "+f.joinToString(" ")
  }
  @Test fun countsZeroSparseAndHugeRangesWithoutExpanding() {
    for ((list,count) in listOf("0" to 1L,"0-7" to 8L,"0,2-4,128" to 5L,"0-2147483647" to 2147483648L))
      assertEquals(count,ThreadAffinity.count(list))
  }
  @Test fun rejectsMalformedDuplicateOverlappingAndOversizedLists() {
    for (list in listOf("", "-1", "1-0", "0,0", "1,0", "0-3,3-5", "01", "0,", "1.5", "0 - 2", "2147483648", "0-999999999999999999999", "0,".repeat(600)))
      assertThrows(Exception::class.java){ThreadAffinity.count(list)}
  }
  @Test fun statusRequiresExactSingleFieldsAndThreadIdentity() {
    assertEquals("0-7" to 8L,ThreadAffinity.parse("Pid:\t42\nCpus_allowed_list:\t0-7\n", "42"))
    for (text in listOf("Pid: 43\nCpus_allowed_list: 0", "Pid: 42\n", "Pid: 42\nCpus_allowed_list: 0\nCpus_allowed_list: 1", "Pid: 42\nPid: 42\nCpus_allowed_list: 0"))
      assertThrows(Exception::class.java){ThreadAffinity.parse(text,"42")}
  }
  @Test fun rechecksLifetimeAfterReadingStatus() {
    val paths=mutableListOf<String>()
    val result=ThreadAffinity.readWith("42","99") { path -> paths.add(path);if(path.endsWith("status"))"Pid: 42\nCpus_allowed_list: 0-3" else stat("99") }
    assertTrue(result.available);assertEquals(4L,result.cpuCount);assertNull(result.reason)
    assertEquals(listOf("/proc/self/task/42/status","/proc/self/task/42/stat"),paths)
    val reused=ThreadAffinity.readWith("42","99") { if(it.endsWith("status"))"Pid: 42\nCpus_allowed_list: 0" else stat("100") }
    assertFalse(reused.available);assertEquals("identity_changed",reused.reason);assertNull(reused.cpuList)
  }
  @Test fun failuresRemainSeparateFromThePreviouslyReadCpuStat() {
    val cpu=ThreadCpuStat.parse(stat("99"),"42")
    for (failStat in listOf(false,true)) {
      val result=ThreadAffinity.readWith("42",cpu.startTicks) {
        if(!failStat||it.endsWith("stat"))throw java.io.IOException("gone")
        "Pid: 42\nCpus_allowed_list: 0"
      }
      assertFalse(result.available);assertNull(result.cpuCount);assertEquals("99",cpu.startTicks)
    }
  }
}
