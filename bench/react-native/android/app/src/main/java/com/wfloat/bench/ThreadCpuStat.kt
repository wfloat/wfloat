package com.wfloat.bench

internal data class ThreadCpuStat(val tid: String, val name: String, val startTicks: String, val user: Long, val system: Long, val runState: String, val priority: Int, val nice: Int, val policy: Long, val rtPriority: Long, val lastCpu: Int) {
  companion object {
    fun parse(text: String, expectedTid: String): ThreadCpuStat {
      val open = text.indexOf('(')
      val close = text.lastIndexOf(')')
      require(open > 0 && close > open && text.substring(0, open).trim() == expectedTid) { "Invalid thread stat identity" }
      // comm can contain spaces, parentheses and newlines. Numeric fields follow its final ')'.
      val fields = text.substring(close + 1).trim().split(Regex("\\s+"))
      require(fields.size >= 39) { "Incomplete thread stat" }
      fun exact(index: Int): Long {
        require(fields[index].matches(Regex("[0-9]+"))) { "Invalid thread counter" }
        return fields[index].toLong().also { require(it in 0..9007199254740991L) { "Inexact thread counter" } }
      }
      fun signed(index: Int): Int {
        require(fields[index].matches(Regex("-?(0|[1-9][0-9]*)"))) { "Invalid signed thread value" }
        return fields[index].toInt()
      }
      val lastCpu = signed(36) // stat field 39: CPU number last executed on.
      require(lastCpu >= 0) { "Invalid last logical CPU" }
      val rtPriority = exact(37) // stat field 40.
      val policy = exact(38) // stat field 41; preserve unknown unsigned codes.
      require(rtPriority <= 4294967295L && policy <= 4294967295L) { "Invalid scheduler value" }
      val priority = signed(15) // stat field 18; signed raw task priority, not nice.
      val nice = signed(16) // stat field 19.
      require(nice in -20..19) { "Invalid thread nice value" }
      val state = fields[0]
      require(state.length == 1 && state[0].code in 33..126) { "Invalid thread state" }
      val user = exact(11); val system = exact(12)
      require(user <= 9007199254740991L - system) { "Inexact total thread time" }
      val start = fields[19]
      require(start.matches(Regex("[0-9]+"))) { "Invalid thread start time" }
      start.toULong() // Preserve lifetime identity as a string across the JS bridge.
      return ThreadCpuStat(expectedTid, text.substring(open + 1, close), start, user, system, state, priority, nice, policy, rtPriority, lastCpu)
    }
  }
}
