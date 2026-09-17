package com.wfloat.bench

import org.junit.Assert.*
import org.junit.Test

class ThreadStatusTest {
  private val text = "Pid: 42\nCpus_allowed_list: 0-3\nvoluntary_ctxt_switches: 0\nnonvoluntary_ctxt_switches: 18446744073709551615\n"
  private fun stat(start: String): String {
    val f=MutableList(39){"0"}; f[0]="S"; f[19]=start
    return "42 (worker) "+f.joinToString(" ")
  }
  @Test fun retainsUnsignedCounterPrecision() {
    assertEquals("0" to "18446744073709551615", ThreadStatus.parseSwitches(text,"42"))
    for (bad in listOf("-1","01","1.0","1e3","18446744073709551616","", "9".repeat(100)))
      assertThrows(Exception::class.java){ThreadStatus.parseSwitches(text.replace("18446744073709551615",bad),"42")}
  }
  @Test fun requiresBothUniqueFieldsAndCorrectPid() {
    for (bad in listOf(text.replace("Pid: 42","Pid: 43"),text+"Pid: 42\n",text+"voluntary_ctxt_switches: 1\n",text.replace("voluntary_ctxt_switches: 0\n","")))
      assertThrows(Exception::class.java){ThreadStatus.parseSwitches(bad,"42")}
  }
  @Test fun readsStatusOnceAndRechecksIdentityOnce() {
    val paths=mutableListOf<String>()
    val result=ThreadStatus.readWith("42","99"){paths.add(it);if(it.endsWith("status"))text else stat("99")}
    assertTrue(result.affinity.available);assertTrue(result.switches.available)
    assertEquals(text, result.rawStatus);assertTrue(result.identityVerified)
    assertEquals(listOf("/proc/self/task/42/status","/proc/self/task/42/stat"),paths)
    assertEquals("18446744073709551615",result.switches.involuntaryCount)
  }
  @Test fun fieldFailuresAreIndependent() {
    val badAffinity=ThreadStatus.readWith("42","99"){if(it.endsWith("status"))text.replace("0-3","3-0") else stat("99")}
    assertFalse(badAffinity.affinity.available);assertTrue(badAffinity.switches.available)
    val badSwitch=ThreadStatus.readWith("42","99"){if(it.endsWith("status"))text.replace("voluntary_ctxt_switches: 0","voluntary_ctxt_switches: -1") else stat("99")}
    assertTrue(badSwitch.affinity.available);assertFalse(badSwitch.switches.available);assertNull(badSwitch.switches.involuntaryCount)
  }
  @Test fun changedOrUnreadableIdentityInvalidatesBothWithoutInventingZeros() {
    for (mode in 0..3) {
      val result=ThreadStatus.readWith("42","99"){
        if(mode==0 || (mode==1&&it.endsWith("stat")))throw java.io.IOException("gone")
        if(it.endsWith("status"))text.replace("Pid: 42",if(mode==3)"Pid: 43" else "Pid: 42") else stat("100")
      }
      assertFalse(result.affinity.available);assertFalse(result.switches.available)
      assertFalse(result.identityVerified)
      if (mode == 0) assertNull(result.rawStatus) else assertNotNull(result.rawStatus)
      assertNull(result.switches.voluntaryCount);assertNull(result.switches.involuntaryCount)
      if(mode==2)assertEquals("identity_changed",result.switches.reason)
    }
  }
}
