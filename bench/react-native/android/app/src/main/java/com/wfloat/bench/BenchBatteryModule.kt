package com.wfloat.bench

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.BatteryManager
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.os.Process
import android.os.SystemClock
import android.util.Log
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.LifecycleEventListener
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.common.LifecycleState
import org.json.JSONObject
import java.util.concurrent.atomic.AtomicInteger

class BenchBatteryModule(context: ReactApplicationContext) :
  ReactContextBaseJavaModule(context), LifecycleEventListener {
  private val thread = HandlerThread("WfloatBattery").apply { start() }
  private val handler = Handler(thread.looper)
  @Volatile private var foreground = context.lifecycleState == LifecycleState.RESUMED
  @Volatile private var closed = false
  // All remaining state is owned by the handler thread.
  private var receiver: BroadcastReceiver? = null
  private var report: Map<String, Any?>? = null
  private var voltageReport: Map<String, Any?>? = null
  private var error: String? = null
  private var refreshActive = false
  private var refreshProbeId: Int? = null
  private var refreshStartedUptimeMs: Double? = null
  private var refreshDeadlineUptimeMs: Double? = null
  private var refreshRequests = 0
  private var refreshSent = 0
  private var refreshReports = 0
  private var refreshStopReason: String? = null
  private var lastRefresh: Map<String, Any?>? = null
  private val refreshTick = object : Runnable {
    override fun run() {
      if (!refreshActive) return
      if (!foreground || closed) { stopRefresh("background"); return }
      if (uptimeMs() >= refreshDeadlineUptimeMs!! || refreshRequests >= 30) {
        stopRefresh("completed"); return
      }
      requestRefresh()
      if (refreshActive) handler.postDelayed(this, 2000)
    }
  }

  init {
    context.addLifecycleEventListener(this)
    handler.post { startListening() }
  }
  override fun getName() = "BenchBattery"

  private fun startListening() {
    if (closed || !foreground || receiver != null) return
    val next = object : BroadcastReceiver() {
      @Suppress("DEPRECATION")
      override fun onReceive(context: Context?, intent: Intent?) {
        if (closed || !foreground || receiver !== this || intent?.action != Intent.ACTION_BATTERY_CHANGED) return
        try {
          val receivedAtMs = System.currentTimeMillis().toDouble()
          val receivedUptimeMs = SystemClock.elapsedRealtimeNanos() / 1_000_000.0
          val extras = intent.extras
          val fields = batteryTemperatureFields(
            intent.hasExtra(BatteryManager.EXTRA_TEMPERATURE),
            extras?.get(BatteryManager.EXTRA_TEMPERATURE),
            extras?.get(BatteryManager.EXTRA_PRESENT),
            extras?.get(BatteryManager.EXTRA_STATUS),
            extras?.get(BatteryManager.EXTRA_PLUGGED)
          )
          val metadata = mapOf(
            "receiptKind" to if (isInitialStickyBroadcast) "sticky_cache" else "broadcast",
            "receivedAtMs" to receivedAtMs,
            "receivedUptimeMs" to receivedUptimeMs,
            "sensorSampledAtMs" to null,
            "sequence" to sequence.incrementAndGet(),
            "pid" to Process.myPid(),
            "apiLevel" to Build.VERSION.SDK_INT,
            "osVersion" to Build.VERSION.RELEASE
          )
          val collection = collectionContext()
          if (refreshActive && !isInitialStickyBroadcast) refreshReports++
          val nextReport = fields + metadata + collection + mapOf("source" to "ACTION_BATTERY_CHANGED/EXTRA_TEMPERATURE")
          val nextVoltage = batteryVoltageFields(
            intent.hasExtra(BatteryManager.EXTRA_VOLTAGE),
            extras?.get(BatteryManager.EXTRA_VOLTAGE),
            extras?.get(BatteryManager.EXTRA_PRESENT)
          ) + metadata + collection + fields.filterKeys { it in setOf("batteryPresent", "statusRaw", "pluggedRaw") } +
            mapOf("source" to "ACTION_BATTERY_CHANGED/EXTRA_VOLTAGE")
          report = nextReport
          voltageReport = nextVoltage
          error = null
          // One row per OS delivery, including an explicitly identified initial cached report.
          Log.i("WfloatBattery", JSONObject(nextReport).toString())
          Log.i("WfloatBatteryVoltage", JSONObject(nextVoltage).toString())
        } catch (cause: Exception) {
          report = null
          voltageReport = null
          error = "Battery report could not be decoded (${cause.javaClass.simpleName})."
        }
      }
    }
    receiver = next
    try {
      val filter = IntentFilter(Intent.ACTION_BATTERY_CHANGED)
      if (Build.VERSION.SDK_INT >= 33) {
        reactApplicationContext.registerReceiver(next, filter, null, handler, Context.RECEIVER_NOT_EXPORTED)
      } else {
        reactApplicationContext.registerReceiver(next, filter, null, handler)
      }
      // The return value is also sticky data. Let onReceive process it once, with its sticky flag.
      error = null
    } catch (cause: Exception) {
      receiver = null
      report = null
      voltageReport = null
      error = "Battery reports are unavailable (${cause.javaClass.simpleName})."
    }
  }

  private fun stopListening() {
    stopRefresh("background")
    val old = receiver
    receiver = null
    report = null
    voltageReport = null
    error = null
    if (old != null) reactApplicationContext.unregisterReceiver(old)
  }

  private fun uptimeMs() = SystemClock.elapsedRealtimeNanos() / 1_000_000.0

  private fun collectionContext() = mapOf(
    "collectionMode" to if (refreshActive) "refresh_probe" else "passive",
    // Describes the collection window, never proves a request caused this report.
    "refreshProbeId" to if (refreshActive) refreshProbeId else null
  )

  private fun refreshSnapshot() = mapOf(
    "active" to refreshActive, "probeId" to refreshProbeId,
    "startedUptimeMs" to refreshStartedUptimeMs, "deadlineUptimeMs" to refreshDeadlineUptimeMs,
    "remainingMs" to if (refreshActive) (refreshDeadlineUptimeMs!! - uptimeMs()).coerceAtLeast(0.0) else 0.0,
    "requests" to refreshRequests, "sent" to refreshSent, "reportsDuringProbe" to refreshReports,
    "stopReason" to refreshStopReason, "lastRequest" to lastRefresh
  )

  private fun logRefresh(event: String, extra: Map<String, Any?> = emptyMap()) {
    val row = mapOf(
      "source" to "IBatteryPropertiesRegistrar.scheduleUpdate/experimental",
      "event" to event, "sequence" to refreshSequence.incrementAndGet(),
      "pid" to Process.myPid(), "uid" to Process.myUid(), "apiLevel" to Build.VERSION.SDK_INT,
      "targetSdk" to reactApplicationContext.applicationInfo.targetSdkVersion,
      "osVersion" to Build.VERSION.RELEASE, "fingerprint" to Build.FINGERPRINT,
      "recordedAtMs" to System.currentTimeMillis().toDouble(), "recordedUptimeMs" to uptimeMs(),
      "probeId" to refreshProbeId, "requests" to refreshRequests, "sent" to refreshSent,
      "reportsDuringProbe" to refreshReports
    ) + extra
    Log.i("WfloatBatteryRefresh", JSONObject(row).toString())
  }

  private fun stopRefresh(reason: String) {
    if (!refreshActive) return
    handler.removeCallbacks(refreshTick)
    refreshActive = false
    refreshStopReason = reason
    logRefresh("stop", mapOf("reason" to reason))
  }

  private fun requestRefresh() {
    val beforeSequence = voltageReport?.get("sequence")
    val startedAtMs = System.currentTimeMillis().toDouble()
    val startedUptimeMs = uptimeMs()
    val access = requestBatteryHealthRefresh(Build.VERSION.SDK_INT)
    val completedUptimeMs = uptimeMs()
    refreshRequests++
    if (access["outcome"] == "request_sent") refreshSent++
    val result = access + mapOf(
      "startedAtMs" to startedAtMs, "startedUptimeMs" to startedUptimeMs,
      "completedUptimeMs" to completedUptimeMs, "callDurationMs" to completedUptimeMs - startedUptimeMs,
      "previousVoltageSequence" to beforeSequence, "sensorSampledAtMs" to null
    )
    lastRefresh = result
    logRefresh("request", result)
    if (access["outcome"] != "request_sent") stopRefresh("access_failed")
  }

  @ReactMethod
  fun readRefreshProbe(promise: Promise) {
    if (closed || !handler.post { promise.resolve(Arguments.makeNativeMap(refreshSnapshot())) })
      promise.reject("BATTERY_CLOSED", "Battery collector has closed.")
  }

  @ReactMethod
  fun startRefreshProbe(promise: Promise) {
    if (closed || !handler.post {
      if (closed || !foreground) {
        promise.reject("BATTERY_INACTIVE", "The refresh probe requires the app in the foreground.")
        return@post
      }
      if (!refreshActive) {
        startListening()
        refreshProbeId = probeSequence.incrementAndGet()
        refreshStartedUptimeMs = uptimeMs()
        refreshDeadlineUptimeMs = refreshStartedUptimeMs!! + 60_000
        refreshRequests = 0; refreshSent = 0; refreshReports = 0
        refreshStopReason = null; lastRefresh = null; refreshActive = true
        logRefresh("start", mapOf("durationMs" to 60_000, "intervalMs" to 2000, "maxRequests" to 30))
        refreshTick.run()
      }
      promise.resolve(Arguments.makeNativeMap(refreshSnapshot()))
    }) promise.reject("BATTERY_CLOSED", "Battery collector has closed.")
  }

  @ReactMethod
  fun stopRefreshProbe(promise: Promise) {
    if (closed || !handler.post {
      stopRefresh("user")
      promise.resolve(Arguments.makeNativeMap(refreshSnapshot()))
    }) promise.reject("BATTERY_CLOSED", "Battery collector has closed.")
  }

  @ReactMethod
  fun read(promise: Promise) {
    if (closed || !handler.post {
      if (closed || !foreground) {
        promise.reject("BATTERY_INACTIVE", "Battery monitoring is paused while the app is inactive.")
      } else {
        startListening()
        // Reading this cache does not receive a new report or change its sequence/timestamps.
        val result = Arguments.createMap()
        result.putMap("report", report?.let { Arguments.makeNativeMap(it) })
        result.putMap("voltageReport", voltageReport?.let { Arguments.makeNativeMap(it) })
        // Same monotonic clock as receipt timestamps; wall-clock changes cannot alter age.
        result.putDouble("readUptimeMs", uptimeMs())
        result.putString("error", error)
        promise.resolve(result)
      }
    }) promise.reject("BATTERY_CLOSED", "Battery collector has closed.")
  }

  @ReactMethod
  fun readCurrent(promise: Promise) {
    if (closed || !handler.post {
      if (closed || !foreground) {
        promise.reject("BATTERY_INACTIVE", "Battery monitoring is paused while the app is inactive.")
        return@post
      }
      startListening()
      // Context is a separately delivered OS report, not an atomic part of the current read.
      val context = report?.filterKeys { it in setOf(
        "batteryPresent", "statusRaw", "pluggedRaw", "receiptKind",
        "receivedAtMs", "receivedUptimeMs", "sequence"
      ) }
      val startedAtMs = System.currentTimeMillis().toDouble()
      val startedUptimeMs = SystemClock.elapsedRealtimeNanos() / 1_000_000.0
      var raw: Long? = null
      var failure: String? = null
      try {
        val manager = reactApplicationContext.getSystemService(Context.BATTERY_SERVICE) as? BatteryManager
        // Both property getters use the same underlying query. The long getter preserves
        // the unavailable sentinel even on API 24–27, whose int getter can turn it into 0.
        raw = manager?.getLongProperty(BatteryManager.BATTERY_PROPERTY_CURRENT_NOW)
      } catch (cause: Exception) {
        failure = "query_failed:${cause.javaClass.simpleName}"
      }
      val completedUptimeMs = SystemClock.elapsedRealtimeNanos() / 1_000_000.0
      val completedAtMs = System.currentTimeMillis().toDouble()
      if (closed || !foreground) {
        promise.reject("BATTERY_INACTIVE", "Battery monitoring is paused while the app is inactive.")
        return@post
      }
      val sample = batteryCurrentFields(raw, context?.get("batteryPresent") as? Boolean, failure) + collectionContext() + mapOf(
        "source" to "BatteryManager.getLongProperty(BATTERY_PROPERTY_CURRENT_NOW)",
        "readStartedAtMs" to startedAtMs, "readCompletedAtMs" to completedAtMs,
        "readStartedUptimeMs" to startedUptimeMs, "readCompletedUptimeMs" to completedUptimeMs,
        "queryDurationMs" to completedUptimeMs - startedUptimeMs,
        "sensorSampledAtMs" to null, "batteryContext" to context,
        "sequence" to currentSequence.incrementAndGet(), "pid" to Process.myPid(),
        "apiLevel" to Build.VERSION.SDK_INT, "osVersion" to Build.VERSION.RELEASE
      )
      Log.i("WfloatBatteryCurrent", JSONObject(sample).toString())
      promise.resolve(Arguments.makeNativeMap(sample))
    }) promise.reject("BATTERY_CLOSED", "Battery collector has closed.")
  }

  @ReactMethod
  fun readChargeCounter(promise: Promise) {
    if (closed || !handler.post {
      if (closed || !foreground) {
        promise.reject("BATTERY_INACTIVE", "Battery monitoring is paused while the app is inactive.")
        return@post
      }
      startListening()
      // Context is a separately delivered OS report, not an atomic part of the charge-counter read.
      val context = report?.filterKeys { it in setOf(
        "batteryPresent", "statusRaw", "pluggedRaw", "receiptKind",
        "receivedAtMs", "receivedUptimeMs", "sequence"
      ) }
      val startedAtMs = System.currentTimeMillis().toDouble()
      val startedUptimeMs = SystemClock.elapsedRealtimeNanos() / 1_000_000.0
      var raw: Long? = null
      var failure: String? = null
      try {
        val manager = reactApplicationContext.getSystemService(Context.BATTERY_SERVICE) as? BatteryManager
        // Both property getters use the same underlying query. The long getter preserves
        // the unavailable sentinel even on API 24–27, whose int getter can turn it into 0.
        raw = manager?.getLongProperty(BatteryManager.BATTERY_PROPERTY_CHARGE_COUNTER)
      } catch (cause: Exception) {
        failure = "query_failed:${cause.javaClass.simpleName}"
      }
      val completedUptimeMs = SystemClock.elapsedRealtimeNanos() / 1_000_000.0
      val completedAtMs = System.currentTimeMillis().toDouble()
      if (closed || !foreground) {
        promise.reject("BATTERY_INACTIVE", "Battery monitoring is paused while the app is inactive.")
        return@post
      }
      val sample = batteryChargeFields(raw, context?.get("batteryPresent") as? Boolean, failure) + collectionContext() + mapOf(
        "source" to "BatteryManager.getLongProperty(BATTERY_PROPERTY_CHARGE_COUNTER)",
        "scope" to "battery_remaining_charge", "platform" to "android",
        "clockSource" to "SystemClock.elapsedRealtimeNanos",
        "environment" to if (Build.FINGERPRINT.startsWith("generic") || Build.FINGERPRINT.contains("emulator") ||
          Build.MODEL.contains("sdk_gphone") || Build.HARDWARE in setOf("goldfish", "ranchu")) "emulator" else "device",
        "environmentDetection" to "build_heuristic",
        "readStartedAtMs" to startedAtMs, "readCompletedAtMs" to completedAtMs,
        "readStartedUptimeMs" to startedUptimeMs, "readCompletedUptimeMs" to completedUptimeMs,
        "queryDurationMs" to completedUptimeMs - startedUptimeMs,
        "sensorSampledAtMs" to null, "batteryContext" to context,
        "sequence" to chargeSequence.incrementAndGet(), "pid" to Process.myPid(),
        "apiLevel" to Build.VERSION.SDK_INT, "osVersion" to Build.VERSION.RELEASE
      )
      Log.i("WfloatBatteryCharge", JSONObject(sample).toString())
      promise.resolve(Arguments.makeNativeMap(sample))
    }) promise.reject("BATTERY_CLOSED", "Battery collector has closed.")
  }

  override fun onHostResume() { foreground = true; handler.post { startListening() } }
  override fun onHostPause() { foreground = false; handler.post { stopListening() } }
  override fun onHostDestroy() { foreground = false; handler.post { stopListening() } }
  @Synchronized override fun invalidate() {
    if (closed) return
    closed = true
    foreground = false
    reactApplicationContext.removeLifecycleEventListener(this)
    handler.post {
      try { stopListening() } finally { thread.quitSafely() }
    }
    super.invalidate()
  }

  companion object {
    private val sequence = AtomicInteger()
    private val currentSequence = AtomicInteger()
    private val chargeSequence = AtomicInteger()
    private val refreshSequence = AtomicInteger()
    private val probeSequence = AtomicInteger()
  }
}
