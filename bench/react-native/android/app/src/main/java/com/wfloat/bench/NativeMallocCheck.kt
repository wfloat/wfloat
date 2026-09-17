package com.wfloat.bench

/** JNI reads this guard between bounded allocation/touch operations. */
fun interface NativeMallocGuard { fun isActive(): Boolean }
internal interface NativeMallocOperations {
  fun step(operation: Int, guard: NativeMallocGuard)
  fun heldBytes(): Long
  fun close()
}

/** Runs on the existing memory worker; phase reads use the public Debug APIs. */
internal fun runNativeMallocCheck(
  run: Long,
  clockNanos: () -> Long,
  isActive: () -> Boolean,
  create: () -> NativeMallocOperations,
  read: () -> List<Map<String, Any?>>,
): Map<String, Any?> {
  val started = clockNanos()
  val guard = NativeMallocGuard { isActive() && clockNanos() - started < 10_000_000_000L }
  val phases = mutableListOf<Map<String, Any?>>()
  var operations: NativeMallocOperations? = null
  var error: String? = null
  var stage = "completed"
  fun checkActive() { check(guard.isActive()) { "Native allocation check interrupted or timed out" } }
  fun capture(name: String) {
    checkActive()
    val before = clockNanos()
    val counters = read()
    val after = clockNanos()
    check(counters.size == 3) { "Native allocation check requires three counters" }
    checkActive()
    phases.add(mapOf("stage" to name, "heldBytes" to operations!!.heldBytes().toDouble(),
      "queryStartedUptimeMs" to before.toDouble() / 1e6,
      "queryFinishedUptimeMs" to after.toDouble() / 1e6,
      "allocated" to counters[0], "free" to counters[1], "size" to counters[2]))
  }
  try {
    checkActive(); operations = create()
    capture("baseline")
    for ((operation, name) in listOf(1 to "small_held", 0 to "small_released",
      1 to "small_reused", 2 to "small_half_released", 0 to "small_released_again",
      3 to "large_held", 0 to "large_released", 4 to "mmap_held", 0 to "mmap_released")) {
      operations.step(operation, guard); capture(name)
    }
  } catch (failure: Exception) {
    error = failure.message ?: failure.javaClass.simpleName
    stage = if (!guard.isActive()) "cancelled" else "failed"
  } finally { operations?.close() }
  return mapOf("run" to run.toDouble(), "stage" to stage, "phases" to phases, "error" to error,
    "schemaVersion" to 1, "scope" to "calling_process", "maxHeldBytes" to 16777216,
    "heldBytes" to 0, "queryStartedUptimeMs" to started.toDouble() / 1e6,
    "queryFinishedUptimeMs" to clockNanos().toDouble() / 1e6,
    "clockSource" to "SystemClock.elapsedRealtimeNanos")
}
