package com.wfloat.bench

internal data class ThreadAffinityResult(val available: Boolean, val cpuList: String?, val cpuCount: Long?, val reason: String?)

internal object ThreadAffinity {
  fun count(cpuList: String): Long {
    require(cpuList.isNotEmpty() && cpuList.length <= 1024) { "Invalid or oversized CPU list" }
    var previous = -1L
    var count = 0L
    for (item in cpuList.split(',')) {
      require(item.matches(Regex("(0|[1-9][0-9]*)(-(0|[1-9][0-9]*))?"))) { "Invalid CPU range" }
      val pair = item.split('-')
      val first = pair[0].toLong()
      val last = if (pair.size == 2) pair[1].toLong() else first
      require(first > previous && last >= first && last <= Int.MAX_VALUE) { "Invalid CPU range order" }
      count += last - first + 1
      previous = last
    }
    return count // Count ranges without allocating an array for every possible CPU ID.
  }
  fun parse(text: String, tid: String): Pair<String, Long> {
    fun field(key: String): String {
      val lines = text.lineSequence().filter { it.startsWith("$key:") }.toList()
      require(lines.size == 1) { "Missing or duplicate $key" }
      return lines.single().substringAfter(':').trim()
    }
    require(field("Pid") == tid) { "Unexpected status thread identity" }
    val list = field("Cpus_allowed_list")
    return list to count(list)
  }
  fun read(tid: String, startTicks: String): ThreadAffinityResult = ThreadStatus.read(tid, startTicks).affinity
  fun readWith(tid: String, startTicks: String, readFile: (String) -> String): ThreadAffinityResult =
    ThreadStatus.readWith(tid, startTicks, readFile).affinity
}
