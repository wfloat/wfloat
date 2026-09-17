package com.wfloat.bench

internal object ProcessThreadCount {
  private val field = Regex("^Threads:\\s*([0-9]+)\\s*$")
  fun parse(status: String): Int {
    val lines = status.lineSequence().filter { it.startsWith("Threads:") }.toList()
    require(lines.size == 1) { "Missing or duplicate Threads field in /proc/self/status" }
    val count = field.matchEntire(lines.single())?.groupValues?.get(1)?.toIntOrNull()
    require(count != null && count > 0) { "Invalid Threads field in /proc/self/status" }
    return count
  }
}
