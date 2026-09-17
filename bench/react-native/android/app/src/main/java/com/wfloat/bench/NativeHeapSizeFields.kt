package com.wfloat.bench

import android.os.Debug

/** Preserve signed API output before conversion to a JavaScript number. */
internal fun nativeHeapSizeFields(raw: Long?, failure: String? = null): Map<String, Any?> {
  val error = when {
    failure != null -> failure
    raw == null -> "Native heap size query returned no reading"
    raw < 0 -> "Native heap size query returned negative bytes"
    raw > 9007199254740991L -> "Native heap size bytes exceed exact JavaScript integer range"
    else -> null
  }
  return mapOf(
    "source" to "Debug.getNativeHeapSize()",
    "scope" to "calling_process", "unit" to "bytes", "accounting" to "native_allocator_size_bytes",
    "rawBytes" to raw?.toString(), "bytes" to if (error == null) raw!!.toDouble() else null,
    "error" to error
  )
}

@JvmOverloads
internal fun readNativeHeapSize(read: () -> Long = { Debug.getNativeHeapSize() }): Map<String, Any?> =
  try { nativeHeapSizeFields(read()) }
  catch (cause: Exception) { nativeHeapSizeFields(null, "Native heap size query failed: ${cause.javaClass.simpleName}") }
