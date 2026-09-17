package com.wfloat.bench

import android.os.Debug

/** Retain the API string verbatim, including malformed or out-of-range evidence. */
internal fun artGcTimeFields(raw: String?, failure: String? = null): Map<String, Any?> {
  val canonical = raw != null && Regex("0|[1-9][0-9]*").matches(raw)
  val parsed = if (canonical) raw?.toLongOrNull() else null
  val error = when {
    failure != null -> failure
    raw == null -> "ART garbage-collection time is unavailable"
    !canonical -> "ART garbage-collection time is not a nonnegative decimal integer"
    parsed == null || parsed > 9007199254740991L -> "ART garbage-collection time exceeds exact JavaScript integer range"
    else -> null
  }
  return mapOf(
    "source" to "Debug.getRuntimeStat(\"art.gc.gc-time\")",
    "statistic" to "art.gc.gc-time", "runtime" to "ART", "unit" to "milliseconds",
    "accounting" to "art_gc_run_duration",
    "scope" to "process_lifetime", "approximate" to true,
    "rawMilliseconds" to raw, "milliseconds" to if (error == null) parsed!!.toDouble() else null,
    "error" to error
  )
}

@JvmOverloads
internal fun readArtGcTime(read: () -> String? = { Debug.getRuntimeStat("art.gc.gc-time") }): Map<String, Any?> =
  try { artGcTimeFields(read()) }
  catch (cause: Exception) { artGcTimeFields(null, "ART garbage-collection time query failed: ${cause.javaClass.simpleName}") }
