package com.wfloat.bench

/** Preserve signed API output before conversion to a JavaScript number. */
internal fun nativeHeapAllocatedFields(raw: Long?, failure: String? = null): Map<String, Any?> {
  val error = when {
    failure != null -> failure
    raw == null -> "Native heap query returned no reading"
    raw < 0 -> "Native heap query returned negative bytes"
    raw > 9007199254740991L -> "Native heap allocated bytes exceed exact JavaScript integer range"
    else -> null
  }
  return mapOf(
    "source" to "Debug.getNativeHeapAllocatedSize()",
    "scope" to "calling_process", "unit" to "bytes", "accounting" to "native_allocator_bytes",
    "rawBytes" to raw?.toString(), "bytes" to if (error == null) raw!!.toDouble() else null,
    "error" to error
  )
}
