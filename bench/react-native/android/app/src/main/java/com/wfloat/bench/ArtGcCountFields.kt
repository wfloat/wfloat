package com.wfloat.bench

import android.os.Debug

/** Retain the API string verbatim, including malformed or out-of-range evidence. */
internal fun artGcCountFields(raw: String?, failure: String? = null): Map<String, Any?> {
  val canonical = raw != null && Regex("0|[1-9][0-9]*").matches(raw)
  val parsed = if (canonical) raw?.toLongOrNull() else null
  val error = when {
    failure != null -> failure
    raw == null -> "ART garbage-collection count is unavailable"
    !canonical -> "ART garbage-collection count is not a nonnegative decimal integer"
    parsed == null || parsed > 9007199254740991L -> "ART garbage-collection count exceeds exact JavaScript integer range"
    else -> null
  }
  return mapOf(
    "source" to "Debug.getRuntimeStat(\"art.gc.gc-count\")",
    "statistic" to "art.gc.gc-count", "runtime" to "ART", "unit" to "collections",
    "scope" to "process_lifetime", "approximate" to true,
    "rawCount" to raw, "count" to if (error == null) parsed!!.toDouble() else null,
    "error" to error
  )
}

@JvmOverloads
internal fun readArtGcCount(read: () -> String? = { Debug.getRuntimeStat("art.gc.gc-count") }): Map<String, Any?> =
  try { artGcCountFields(read()) }
  catch (cause: Exception) { artGcCountFields(null, "ART garbage-collection query failed: ${cause.javaClass.simpleName}") }
