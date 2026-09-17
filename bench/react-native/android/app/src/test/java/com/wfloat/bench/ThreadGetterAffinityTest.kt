package com.wfloat.bench
import org.junit.Assert.*
import org.junit.Test

class ThreadGetterAffinityTest {
  private fun stat(start: String): String {
    val fields=MutableList(39){"0"};fields[0]="S";fields[19]=start
    return "42 (worker) "+fields.joinToString(" ")
  }
  @Test fun queriesExplicitTidAndChecksIdentityAfterwards() {
    val order=mutableListOf<String>()
    val result=ThreadGetterAffinity.readWith("42","99",{assertEquals(42,it);order.add("getter");intArrayOf(0,0,2,1023)},
      {assertEquals("/proc/self/task/42/stat",it);order.add("stat");stat("99")})
    assertTrue(result.available);assertEquals(listOf(0,2,1023),result.cpuIds);assertEquals(listOf("getter","stat"),order)
  }
  @Test fun emptyMaskIsAvailableAndNotAnError() {
    val result=ThreadGetterAffinity.readWith("42","99",{intArrayOf(0)},{stat("99")})
    assertTrue(result.available);assertEquals(emptyList<Int>(),result.cpuIds);assertNull(result.reason)
  }
  @Test fun nativeErrorsRemainDistinctAndDoNotReadOrInventMask() {
    val result=ThreadGetterAffinity.readWith("42","99",{intArrayOf(3)},{throw AssertionError("Unexpected identity read after getter error")})
    assertFalse(result.available);assertNull(result.cpuIds);assertEquals("sched_getaffinity_errno:3",result.reason)
  }
  @Test fun rejectsMalformedNativeResultsAndChangedIdentity() {
    for(raw in listOf(intArrayOf(),intArrayOf(-1),intArrayOf(3,0),intArrayOf(0,-1),intArrayOf(0,0,0),intArrayOf(0,2,1),intArrayOf(0,1024))) {
      val result=ThreadGetterAffinity.readWith("42","99",{raw},{stat("99")});assertFalse(result.available);assertNull(result.cpuIds)
    }
    val reused=ThreadGetterAffinity.readWith("42","99",{intArrayOf(0,0)},{stat("100")})
    assertEquals("identity_changed",reused.reason);assertNull(reused.cpuIds)
  }
  @Test fun fileAndNativeLoadingFailuresStayOptional() {
    assertFalse(ThreadGetterAffinity.readWith("42","99",{intArrayOf(0,0)},{throw java.io.IOException("gone")}).available)
    assertFalse(ThreadGetterAffinity.readWith("42","99",{throw UnsatisfiedLinkError("missing")},{stat("99")}).available)
    for(tid in listOf("0","-1","042","2147483648"))assertFalse(ThreadGetterAffinity.readWith(tid,"99",{throw AssertionError("Bad TID reached getter")},{stat("99")}).available)
  }
}
