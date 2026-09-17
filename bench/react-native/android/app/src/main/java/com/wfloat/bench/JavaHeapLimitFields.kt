package com.wfloat.bench

internal fun javaHeapLimitFields(raw: Long?, failure: String? = null): Map<String, Any?> {
  val kind = when {
    failure != null || raw == null || raw < 0 -> "unavailable"
    raw == Long.MAX_VALUE -> "no_inherent_limit"
    else -> "finite"
  }
  val error = when {
    failure != null -> failure
    raw == null -> "Java heap limit query returned no reading"
    raw < 0 -> "Java heap limit query returned negative bytes"
    kind == "finite" && raw > 9007199254740991L -> "Java heap limit exceeds exact JavaScript integer range"
    else -> null
  }
  return mapOf(
    "source" to "Runtime.maxMemory()", "scope" to "calling_process", "unit" to "bytes",
    "accounting" to "managed_heap_limit_bytes", "limitKind" to kind,
    "rawBytes" to raw?.toString(),
    "bytes" to if (kind == "finite" && error == null) raw!!.toDouble() else null,
    "error" to error
  )
}

@JvmOverloads
internal fun readJavaHeapLimit(read: () -> Long = { Runtime.getRuntime().maxMemory() }): Map<String, Any?> =
  try { javaHeapLimitFields(read()) }
  catch (cause: Exception) { javaHeapLimitFields(null, "Java heap limit query failed: ${cause.javaClass.simpleName}") }
