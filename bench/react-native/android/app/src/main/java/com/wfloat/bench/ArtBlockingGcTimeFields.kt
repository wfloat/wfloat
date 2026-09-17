package com.wfloat.bench

import android.os.Debug

/** Retain the API string verbatim, including malformed or out-of-range evidence. */
internal fun artBlockingGcTimeFields(raw: String?, failure: String? = null): Map<String, Any?> {
  val canonical = raw != null && Regex("0|[1-9][0-9]*").matches(raw)
  val parsed = if (canonical) raw?.toLongOrNull() else null
  val error = when {
    failure != null -> failure
    raw == null -> "ART blocking garbage-collection time is unavailable"
    !canonical -> "ART blocking garbage-collection time is not a nonnegative decimal integer"
    parsed == null || parsed > 9007199254740991L -> "ART blocking garbage-collection time exceeds exact JavaScript integer range"
    else -> null
  }
  return mapOf(
    "source" to "Debug.getRuntimeStat(\"art.gc.blocking-gc-time\")",
    "statistic" to "art.gc.blocking-gc-time", "runtime" to "ART", "unit" to "milliseconds",
    "classification" to "art_blocking_collection",
    "accounting" to "art_blocking_gc_run_duration",
    "scope" to "process_lifetime", "approximate" to true,
    "rawMilliseconds" to raw, "milliseconds" to if (error == null) parsed!!.toDouble() else null,
    "error" to error
  )
}

@JvmOverloads
internal fun readArtBlockingGcTime(read: () -> String? = { Debug.getRuntimeStat("art.gc.blocking-gc-time") }): Map<String, Any?> =
  try { artBlockingGcTimeFields(read()) }
  catch (cause: Exception) { artBlockingGcTimeFields(null, "ART blocking garbage-collection time query failed: ${cause.javaClass.simpleName}") }
