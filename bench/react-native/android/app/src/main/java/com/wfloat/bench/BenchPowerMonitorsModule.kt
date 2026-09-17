package com.wfloat.bench

import android.content.pm.PackageManager
import android.os.*
import android.os.health.SystemHealthManager
import android.util.Log
import androidx.annotation.RequiresApi
import com.facebook.react.bridge.*
import com.facebook.react.common.LifecycleState
import org.json.JSONObject
import java.util.UUID
import java.util.concurrent.Executor
import java.util.concurrent.Executors

class BenchPowerMonitorsModule(private val context: ReactApplicationContext) :
  ReactContextBaseJavaModule(context), LifecycleEventListener {
  private val worker = Executors.newSingleThreadExecutor { r -> Thread(r, "bench-energy") }
  private val watchdog = Handler(Looper.getMainLooper())
  private val inventoryId = UUID.randomUUID().toString()
  private var foreground = context.lifecycleState == LifecycleState.RESUMED
  private var closed = false
  private var sequence = 0
  private var active: Request? = null
  private var api: Api35? = null
  private val callbackExecutor = Executor { task ->
    synchronized(this) { if (!closed) worker.execute(task) }
  }
  private class Request(val promise: Promise, val sequence: Int, val mode: String) {
    val startedNs = SystemClock.elapsedRealtimeNanos()
    var stage = "api_level"
    var finePermissionGranted = false
    var timeout: Runnable? = null
  }

  init { context.addLifecycleEventListener(this) }
  override fun getName() = "BenchPowerMonitors"

  @ReactMethod
  fun read(promise: Promise) = readRequest(promise, "manual")
  @ReactMethod
  fun readComparison(promise: Promise) = readRequest(promise, "comparison")

  @ReactMethod fun recordComparison(json: String, promise: Promise) {
    try {
      require(json.toByteArray(Charsets.UTF_8).size <= 3000) { "Energy comparison record too large" }
      val value = JSONObject(json)
      require(value.getString("source") == "wfloat.energyComparison")
      Log.i("WfloatEnergyCheck", value.toString())
      promise.resolve(null)
    } catch (e: Exception) { promise.reject("ENERGY_LOG_FAILED", e.message, e) }
  }

  @Synchronized private fun readRequest(promise: Promise, mode: String) {
    if (closed || !foreground) { promise.reject("ENERGY_INACTIVE", "Energy reads require the foreground app."); return }
    if (active != null) { promise.reject("ENERGY_BUSY", "An energy read is already in progress."); return }
    val request = Request(promise, ++sequence, mode)
    active = request
    request.timeout = Runnable { finish(request, "error", "callback_timeout") }
    watchdog.postDelayed(request.timeout!!, 10_000)
    worker.execute {
      if (!current(request)) return@execute
      try {
        if (Build.VERSION.SDK_INT < 35) finish(request, "unsupported", "requires_api_35")
        else {
          synchronized(this) {
            request.finePermissionGranted = context.checkSelfPermission("android.permission.ACCESS_FINE_POWER_MONITORS") == PackageManager.PERMISSION_GRANTED
          }
          val service = api ?: Api35().also { api = it }
          service.read(request)
        }
      } catch (e: Exception) { finish(request, "error", "query_failed:${e.javaClass.simpleName}") }
    }
  }

  @Synchronized private fun current(r: Request) = !closed && foreground && active === r
  @Synchronized private fun stage(r: Request, value: String): Boolean {
    if (!current(r)) return false
    r.stage = value
    return true
  }

  @Synchronized private fun finish(r: Request, status: String, reason: String?, rows: List<Map<String, Any?>> = emptyList()) {
    if (!current(r)) return
    active = null
    r.timeout?.let(watchdog::removeCallbacks)
    val endNs = SystemClock.elapsedRealtimeNanos()
    val result = linkedMapOf<String, Any?>(
      "source" to "SystemHealthManager.powerMonitors", "status" to status, "reason" to reason,
      "queryStage" to r.stage, "inventoryId" to inventoryId, "pid" to Process.myPid(),
      "uid" to Process.myUid(), "sequence" to r.sequence, "apiLevel" to Build.VERSION.SDK_INT,
      "fingerprint" to Build.FINGERPRINT, "scope" to "device_subsystems",
      "finePermissionGranted" to r.finePermissionGranted, "collectionMode" to r.mode,
      "queryStartedUptimeMs" to r.startedNs / 1_000_000.0,
      "queryFinishedUptimeMs" to endNs / 1_000_000.0,
      "queryDurationMs" to (endNs - r.startedNs) / 1_000_000.0,
      "recordedAtMs" to System.currentTimeMillis().toDouble(), "monitorCount" to rows.size
    )
    // One row per log entry avoids logcat's per-entry size limit for large inventories.
    Log.i("WfloatEnergy", JSONObject(result + ("kind" to "request")).toString())
    rows.forEach { Log.i("WfloatEnergy", JSONObject(result + mapOf("kind" to "monitor", "monitor" to it)).toString()) }
    result["monitors"] = rows
    r.promise.resolve(Arguments.makeNativeMap(result))
  }

  // Keep API 35 classes behind the runtime check, including on older Android.
  @RequiresApi(35)
  private inner class Api35 {
    private var inventory: List<PowerMonitor>? = null
    fun read(r: Request) {
      if (!stage(r, "system_health_service")) return
      val health = context.getSystemService(SystemHealthManager::class.java)
      if (health == null) { finish(r, "error", "service_missing"); return }
      val cached = inventory
      if (cached != null) { readInventory(r, health, cached); return }
      if (!stage(r, "enumeration")) return
      health.getSupportedPowerMonitors(callbackExecutor) { monitors ->
        if (!current(r)) return@getSupportedPowerMonitors
        inventory = monitors.toList()
        try { readInventory(r, health, inventory!!) }
        catch (e: Exception) { finish(r, "error", "query_failed:${e.javaClass.simpleName}") }
      }
    }

    private fun readInventory(r: Request, health: SystemHealthManager, monitors: List<PowerMonitor>) {
      if (monitors.isEmpty()) { finish(r, "empty", "no_exposed_monitors"); return }
      if (!stage(r, "readings")) return
      health.getPowerMonitorReadings(monitors, callbackExecutor, object : OutcomeReceiver<PowerMonitorReadings, RuntimeException> {
        override fun onResult(readings: PowerMonitorReadings) {
          if (!current(r)) return
          val callbackMs = SystemClock.elapsedRealtime()
          val rows = monitors.mapIndexed { index, monitor ->
            val identity = mapOf<String, Any?>("id" to "$inventoryId:$index", "index" to index,
              "name" to monitor.name, "typeRaw" to monitor.type,
              "type" to when (monitor.type) {
                PowerMonitor.POWER_MONITOR_TYPE_MEASUREMENT -> "rail"
                PowerMonitor.POWER_MONITOR_TYPE_CONSUMER -> "consumer"
                else -> "unknown"
              }, "callbackUptimeMs" to callbackMs.toDouble())
            val values = try { powerMonitorFields(readings.getConsumedEnergy(monitor), readings.getTimestampMillis(monitor), callbackMs) }
              catch (e: Exception) { mapOf("availability" to "error", "reason" to "read_failed:${e.javaClass.simpleName}",
                "rawEnergyUws" to null, "rawSnapshotUptimeMs" to null, "joules" to null, "snapshotAgeAtReadMs" to null) }
            identity + values
          }
          finish(r, "ready", null, rows)
        }
        override fun onError(error: RuntimeException) { finish(r, "error", "callback_failed:${error.javaClass.simpleName}") }
      })
    }
  }

  @Synchronized private fun cancel() {
    val r = active ?: return
    active = null
    r.timeout?.let(watchdog::removeCallbacks)
    r.promise.reject("ENERGY_INACTIVE", "Energy read was cancelled when the app became inactive.")
    // Android exposes no cancellation handle. Late callbacks cannot publish results.
  }
  @Synchronized override fun onHostResume() { foreground = true }
  @Synchronized override fun onHostPause() { foreground = false; cancel() }
  @Synchronized override fun onHostDestroy() { foreground = false; cancel() }
  @Synchronized override fun invalidate() {
    if (closed) return
    closed = true; cancel()
    context.removeLifecycleEventListener(this)
    worker.shutdown() // Already queued callbacks may finish; current() rejects them.
    super.invalidate()
  }
}
