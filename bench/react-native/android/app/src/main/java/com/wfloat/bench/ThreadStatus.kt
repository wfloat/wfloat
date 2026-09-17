package com.wfloat.bench

import java.io.File

internal data class ThreadSwitchesResult(val available: Boolean, val voluntaryCount: String?, val involuntaryCount: String?, val reason: String?)
internal data class ThreadStatusResult(val affinity: ThreadAffinityResult, val switches: ThreadSwitchesResult, val rawStatus: String? = null, val identityVerified: Boolean = false)

/** Shared status snapshot, bracketed by the original CPU stat and an identity recheck. */
internal object ThreadStatus {
  private fun field(text: String, key: String): String {
    val rows = text.lineSequence().filter { it.startsWith("$key:") }.toList()
    require(rows.size == 1) { "Missing or duplicate $key" }
    return rows.single().substringAfter(':').trim()
  }
  fun parseSwitches(text: String, tid: String): Pair<String, String> {
    require(field(text, "Pid") == tid) { "Unexpected status thread identity" }
    fun counter(key: String): String {
      val value = field(text, key)
      require(value.length <= 20 && value.matches(Regex("0|[1-9][0-9]*"))) { "Invalid counter" }
      value.toULong() // Reject overflow; retain exact decimal through the JS bridge.
      return value
    }
    return counter("voluntary_ctxt_switches") to counter("nonvoluntary_ctxt_switches")
  }
  private fun unavailable(reason: String) = ThreadStatusResult(
    ThreadAffinityResult(false, null, null, reason), ThreadSwitchesResult(false, null, null, reason))
  fun read(tid: String, startTicks: String): ThreadStatusResult = readWith(tid, startTicks) { File(it).readText() }
  fun readWith(tid: String, startTicks: String, readFile: (String) -> String): ThreadStatusResult {
    var raw: String? = null
    return try {
      val text = readFile("/proc/self/task/$tid/status")
      raw = text
      require(field(text, "Pid") == tid) { "Unexpected status thread identity" }
      val after = ThreadCpuStat.parse(readFile("/proc/self/task/$tid/stat"), tid)
      if (after.startTicks != startTicks) return unavailable("identity_changed").copy(rawStatus = text)
      // Parse optional metrics independently: one absent/malformed field must not hide the other.
      val affinity = try {
        val (list, count) = ThreadAffinity.parse(text, tid)
        ThreadAffinityResult(true, list, count, null)
      } catch (error: Exception) { ThreadAffinityResult(false, null, null, "read_failed:${error.javaClass.simpleName}") }
      val switches = try {
        val (voluntary, involuntary) = parseSwitches(text, tid)
        ThreadSwitchesResult(true, voluntary, involuntary, null)
      } catch (error: Exception) { ThreadSwitchesResult(false, null, null, "read_failed:${error.javaClass.simpleName}") }
      ThreadStatusResult(affinity, switches, text, true)
    } catch (error: Exception) { unavailable("read_failed:${error.javaClass.simpleName}").copy(rawStatus = raw) }
  }
}
