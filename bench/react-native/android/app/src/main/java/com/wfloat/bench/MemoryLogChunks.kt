package com.wfloat.bench

// Logcat truncates large entries. Keep each JSON fragment below 3000 UTF-8 bytes
// plus a small identity header, without splitting a UTF-16 surrogate pair.
internal object MemoryLogChunks {
  fun encode(json: String, processId: Int, sequence: Long): List<String> {
    require(json.isNotEmpty() && processId > 0 && sequence > 0)
    val parts = mutableListOf<String>()
    var start = 0
    while (start < json.length) {
      var end = minOf(start + 1000, json.length)
      if (end < json.length && Character.isHighSurrogate(json[end - 1]) &&
          Character.isLowSurrogate(json[end])) end--
      parts.add(json.substring(start, end))
      start = end
    }
    return parts.mapIndexed { index, part ->
      "WfloatMemoryChunk pid=$processId seq=$sequence part=${index + 1}/${parts.size} $part"
    }
  }
}
