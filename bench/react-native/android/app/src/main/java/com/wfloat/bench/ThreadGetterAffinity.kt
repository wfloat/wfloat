package com.wfloat.bench

import java.io.File

internal object BenchThreadAffinityNative {
  init { System.loadLibrary("bench_thread_affinity") }
  external fun read(tid: Int): IntArray
}
internal data class ThreadGetterAffinityResult(val available: Boolean, val cpuIds: List<Int>?, val reason: String?)
internal object ThreadGetterAffinity {
  fun read(tid: String, startTicks: String): ThreadGetterAffinityResult = readWith(tid, startTicks,
    { BenchThreadAffinityNative.read(it) }, { File(it).readText() })
  fun readWith(tid: String, startTicks: String, getter: (Int) -> IntArray, readFile: (String) -> String): ThreadGetterAffinityResult {
    fun unavailable(reason: String) = ThreadGetterAffinityResult(false, null, reason)
    return try {
      val id = tid.toInt(); require(id > 0 && id.toString() == tid) { "Invalid thread ID" }
      val raw = getter(id)
      require(raw.isNotEmpty() && raw.size <= 1025 && raw[0] >= 0) { "Invalid native response" }
      if (raw[0] != 0) {
        require(raw.size == 1) { "Error response contains CPU IDs" }
        return unavailable("sched_getaffinity_errno:${raw[0]}")
      }
      val ids = raw.drop(1)
      require(ids.all { it in 0..1023 } && ids.zipWithNext().all { (a,b) -> a < b }) { "Invalid CPU IDs" }
      val after = ThreadCpuStat.parse(readFile("/proc/self/task/$tid/stat"), tid)
      if (after.startTicks != startTicks) unavailable("identity_changed")
      else ThreadGetterAffinityResult(true, ids, null)
    } catch (error: Exception) { unavailable("read_failed:${error.javaClass.simpleName}") }
      catch (error: LinkageError) { unavailable("native_unavailable:${error.javaClass.simpleName}") }
  }
}
