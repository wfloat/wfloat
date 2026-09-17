package com.wfloat.bench

import android.os.Debug

/** Preserve signed API output before conversion to a JavaScript number. */
internal fun nativeHeapFreeFields(raw: Long?, failure: String? = null): Map<String, Any?> {
  val error = when {
    failure != null -> failure
    raw == null -> "Native heap free query returned no reading"
    raw < 0 -> "Native heap free query returned negative bytes"
    raw > 9007199254740991L -> "Native heap free bytes exceed exact JavaScript integer range"
    else -> null
  }
  return mapOf(
    "source" to "Debug.getNativeHeapFreeSize()",
    "scope" to "calling_process", "unit" to "bytes", "accounting" to "native_allocator_free_bytes",
    "rawBytes" to raw?.toString(), "bytes" to if (error == null) raw!!.toDouble() else null,
    "error" to error
  )
}

@JvmOverloads
internal fun readNativeHeapFree(read: () -> Long = { Debug.getNativeHeapFreeSize() }): Map<String, Any?> =
  try { nativeHeapFreeFields(read()) }
  catch (cause: Exception) { nativeHeapFreeFields(null, "Native heap free query failed: ${cause.javaClass.simpleName}") }
