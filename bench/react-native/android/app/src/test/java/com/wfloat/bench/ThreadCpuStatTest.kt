package com.wfloat.bench

import org.junit.Assert.*
import org.junit.Test

class ThreadCpuStatTest {
  private fun stat(name: String = "worker", user: String = "120", system: String = "30", start: String = "99", state: String = "R", priority: String = "20", nice: String = "0", policy: String = "0", rt: String = "0", cpu: String = "0"): String {
    val fields = MutableList(39) { "0" }
    fields[36] = cpu; fields[37] = rt; fields[38] = policy; fields[15] = priority; fields[16] = nice; fields[0] = state; fields[11] = user; fields[12] = system; fields[19] = start
    return "42 ($name) " + fields.joinToString(" ")
  }
  @Test fun readsThreadNotChildCpuTimeAndPreservesLifetime() {
    val s = ThreadCpuStat.parse(stat("a ) tricky ( name\n"), "42")
    assertEquals("R", s.runState); assertEquals("42", s.tid); assertEquals("a ) tricky ( name\n", s.name)
    assertEquals(120L, s.user); assertEquals(30L, s.system); assertEquals("99", s.startTicks)
    assertEquals("18446744073709551615", ThreadCpuStat.parse(stat(start = "18446744073709551615"), "42").startTicks)
    assertEquals(0L, ThreadCpuStat.parse(stat(user = "0"), "42").user)
  }
  @Test fun rejectsIncompleteInexactAndWrongIdentity() {
    for (s in listOf("42 (x)", stat(user = "-1"), stat(user = "9007199254740992"),
      stat(user = "9007199254740991", system = "1"), stat(start = "-1"), stat().replace("42 (", "43 ("))) {
      assertThrows(Exception::class.java) { ThreadCpuStat.parse(s, "42") }
    }
  }
  @Test fun preservesCaseAndUnknownStatesWithoutShiftingCpuFields() {
    for (state in listOf("R", "S", "D", "T", "t", "X", "Z", "P", "I", "?", "x", "K", "W")) {
      val s = ThreadCpuStat.parse(stat(name = "a ) tricky ( name\n", state = state), "42")
      assertEquals(state, s.runState); assertEquals(120L, s.user); assertEquals(30L, s.system)
    }
  }
  @Test fun rejectsMalformedStateTokens() {
    for (state in listOf("", " ", "RR", "\u0001", "é"))
      assertThrows(Exception::class.java) { ThreadCpuStat.parse(stat(state = state), "42") }
  }
  @Test fun readsSignedPriorityAndNiceWithoutAssumingTheirRelationship() {
    for ((p, n) in listOf(-101 to 0, -100 to 0, -2 to -20, 0 to -20, 20 to 0, 39 to 19, 12 to 5)) {
      val s = ThreadCpuStat.parse(stat(name = "a ) tricky ( name\n", priority = "$p", nice = "$n"), "42")
      assertEquals(p, s.priority); assertEquals(n, s.nice); assertEquals(120L, s.user); assertEquals("99", s.startTicks)
    }
  }
  @Test fun rejectsInvalidPriorityAndNice() {
    for (p in listOf("1.5", "+2", "2147483648", "-2147483649", "NaN", ""))
      assertThrows(Exception::class.java) { ThreadCpuStat.parse(stat(priority = p), "42") }
    for (n in listOf("-21", "20", "1.5", "NaN", ""))
      assertThrows(Exception::class.java) { ThreadCpuStat.parse(stat(nice = n), "42") }
  }
  @Test fun readsPolicyAndRtPriorityAndPreservesUnknownPairs() {
    for ((policy, rt) in listOf(0L to 0L, 1L to 99L, 2L to 1L, 3L to 0L, 5L to 0L, 6L to 0L, 7L to 0L, 4L to 42L, 4294967295L to 4294967295L)) {
      val s = ThreadCpuStat.parse(stat(name="a ) tricky ( name\n",policy="$policy",rt="$rt"),"42")
      assertEquals(policy,s.policy);assertEquals(rt,s.rtPriority);assertEquals(120L,s.user);assertEquals(20,s.priority)
    }
  }
  @Test fun rejectsTruncatedAndMalformedSchedulerFields() {
    for (v in listOf("-1","1.5","4294967296","NaN","")) {
      assertThrows(Exception::class.java) { ThreadCpuStat.parse(stat(policy=v),"42") }
      assertThrows(Exception::class.java) { ThreadCpuStat.parse(stat(rt=v),"42") }
    }
    assertThrows(Exception::class.java) { ThreadCpuStat.parse(stat().substringBeforeLast(" "),"42") }
  }
  @Test fun readsLastLogicalCpuIncludingZeroWithoutAssumingCoreCount() {
    for (cpu in listOf(0, 3, 128, Int.MAX_VALUE)) {
      val s = ThreadCpuStat.parse(stat(name="a ) tricky ( name\n", cpu="$cpu", policy="3", rt="0"), "42")
      assertEquals(cpu,s.lastCpu);assertEquals(3L,s.policy);assertEquals(0L,s.rtPriority);assertEquals(120L,s.user)
    }
  }
  @Test fun rejectsMalformedLastCpu() {
    for (cpu in listOf("-1", "1.5", "+2", "2147483648", "NaN", ""))
      assertThrows(Exception::class.java) { ThreadCpuStat.parse(stat(cpu=cpu), "42") }
  }

}
