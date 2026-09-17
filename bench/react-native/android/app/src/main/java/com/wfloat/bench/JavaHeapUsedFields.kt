package com.wfloat.bench

internal fun javaHeapUsedFields(totalBefore: Long?, free: Long?, totalAfter: Long?, failure: String? = null): Map<String, Any?> {
  val invalid = when {
    failure != null -> failure
    totalBefore == null || free == null || totalAfter == null -> "Java heap query returned incomplete inputs"
    totalBefore < 0 || free < 0 || totalAfter < 0 -> "Java heap query returned negative bytes"
    totalBefore != totalAfter -> "Java heap size changed during the read"
    free > totalBefore -> "Java heap free bytes exceed total bytes"
    else -> null
  }
  val used = if (invalid == null) totalBefore!! - free!! else null
  val error = invalid ?: if (used!! > 9007199254740991L)
    "Java heap used bytes exceed exact JavaScript integer range" else null
  return mapOf(
    "source" to "Runtime.totalMemory() - Runtime.freeMemory()",
    "scope" to "calling_process", "unit" to "bytes", "accounting" to "managed_heap_used_bytes",
    "consistency" to "total_before_equals_total_after",
    "rawTotalBeforeBytes" to totalBefore?.toString(), "rawFreeBytes" to free?.toString(),
    "rawTotalAfterBytes" to totalAfter?.toString(), "rawBytes" to used?.toString(),
    "bytes" to if (error == null) used!!.toDouble() else null, "error" to error
  )
}

// Bracket freeMemory with totalMemory to detect changing heap capacity. This is
// still an estimate, not an atomic snapshot or an exact live-object inventory.
@JvmOverloads
internal fun readJavaHeapUsed(
  totalRead: () -> Long = { Runtime.getRuntime().totalMemory() },
  freeRead: () -> Long = { Runtime.getRuntime().freeMemory() }
): Map<String, Any?> {
  var before: Long? = null
  var free: Long? = null
  var after: Long? = null
  var failure: String? = null
  try { before = totalRead(); free = freeRead(); after = totalRead() }
  catch (cause: Exception) { failure = "Java heap query failed: ${cause.javaClass.simpleName}" }
  return javaHeapUsedFields(before, free, after, failure)
}
