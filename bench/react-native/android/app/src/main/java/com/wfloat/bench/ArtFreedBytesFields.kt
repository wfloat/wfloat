package com.wfloat.bench

import android.os.Debug

/** Retain the API string verbatim, including malformed or out-of-range evidence. */
internal fun artFreedBytesFields(raw: String?, failure: String? = null): Map<String, Any?> {
  val canonical = raw != null && Regex("0|-?[1-9][0-9]*").matches(raw)
  val parsed = if (canonical) raw?.toLongOrNull() else null
  val error = when {
    failure != null -> failure
    raw == null -> "ART reclaimed-byte accounting is unavailable"
    !canonical -> "ART reclaimed-byte accounting is not a canonical signed decimal integer"
    parsed == null || parsed < -9007199254740991L || parsed > 9007199254740991L -> "ART reclaimed-byte accounting exceeds exact JavaScript integer range"
    else -> null
  }
  return mapOf(
    "source" to "Debug.getRuntimeStat(\"art.gc.bytes-freed\")",
    "statistic" to "art.gc.bytes-freed", "runtime" to "ART", "unit" to "bytes",
    "accounting" to "art_managed_bytes_freed_net",
    "signed" to true, "monotonic" to false,
    "scope" to "process_lifetime", "approximate" to true,
    "rawBytes" to raw, "bytes" to if (error == null) parsed!!.toDouble() else null,
    "error" to error
  )
}

@JvmOverloads
internal fun readArtFreedBytes(read: () -> String? = { Debug.getRuntimeStat("art.gc.bytes-freed") }): Map<String, Any?> =
  try { artFreedBytesFields(read()) }
  catch (cause: Exception) { artFreedBytesFields(null, "ART reclaimed-byte accounting query failed: ${cause.javaClass.simpleName}") }
