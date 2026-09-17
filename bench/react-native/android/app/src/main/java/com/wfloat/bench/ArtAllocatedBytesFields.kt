package com.wfloat.bench

import android.os.Debug

/** Retain the API string verbatim, including malformed or out-of-range evidence. */
internal fun artAllocatedBytesFields(raw: String?, failure: String? = null): Map<String, Any?> {
  val canonical = raw != null && Regex("0|[1-9][0-9]*").matches(raw)
  val parsed = if (canonical) raw?.toLongOrNull() else null
  val error = when {
    failure != null -> failure
    raw == null -> "ART cumulative allocated bytes is unavailable"
    !canonical -> "ART cumulative allocated bytes is not a nonnegative decimal integer"
    parsed == null || parsed > 9007199254740991L -> "ART cumulative allocated bytes exceeds exact JavaScript integer range"
    else -> null
  }
  return mapOf(
    "source" to "Debug.getRuntimeStat(\"art.gc.bytes-allocated\")",
    "statistic" to "art.gc.bytes-allocated", "runtime" to "ART", "unit" to "bytes",
    "accounting" to "art_managed_bytes_allocated_ever",
    "scope" to "process_lifetime", "approximate" to true,
    "rawBytes" to raw, "bytes" to if (error == null) parsed!!.toDouble() else null,
    "error" to error
  )
}

@JvmOverloads
internal fun readArtAllocatedBytes(read: () -> String? = { Debug.getRuntimeStat("art.gc.bytes-allocated") }): Map<String, Any?> =
  try { artAllocatedBytesFields(read()) }
  catch (cause: Exception) { artAllocatedBytesFields(null, "ART cumulative allocated bytes query failed: ${cause.javaClass.simpleName}") }
