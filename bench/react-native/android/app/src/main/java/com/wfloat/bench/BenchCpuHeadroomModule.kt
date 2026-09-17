package com.wfloat.bench

import android.content.Context
import android.os.Build
import android.os.CpuHeadroomParams
import android.os.Process
import android.os.SystemClock
import android.os.health.SystemHealthManager
import android.util.Log
import androidx.annotation.RequiresApi
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.LifecycleEventListener
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.common.LifecycleState
import org.json.JSONObject
import java.util.concurrent.Executors
import java.util.concurrent.RejectedExecutionException

class BenchCpuHeadroomModule(context: ReactApplicationContext) :
  ReactContextBaseJavaModule(context), LifecycleEventListener {
  private val executor = Executors.newSingleThreadExecutor { task -> Thread(task, "bench-headroom") }
  @Volatile private var foreground = context.lifecycleState == LifecycleState.RESUMED
  @Volatile private var closed = false

  init { context.addLifecycleEventListener(this) }
  override fun getName() = "BenchCpuHeadroom"

  @ReactMethod
  fun read(promise: Promise) {
    try {
      executor.execute {
        if (closed || !foreground) {
          promise.reject("CPU_HEADROOM_INACTIVE", "CPU headroom sampling is paused.")
          return@execute
        }
        try {
          val (sample, waitMs) = cadence.read(SystemClock::elapsedRealtime) { query() }
          if (closed || !foreground) {
            promise.reject("CPU_HEADROOM_INACTIVE", "CPU headroom sampling is paused.")
            return@execute
          }
          val result = Arguments.makeNativeMap(sample)
          if (waitMs == null) result.putNull("nextReadInMs")
          else result.putDouble("nextReadInMs", waitMs.toDouble())
          promise.resolve(result)
        } catch (error: Exception) {
          promise.reject("CPU_HEADROOM_READ_FAILED", "Could not deliver CPU headroom.", error)
        }
      }
    } catch (error: RejectedExecutionException) {
      promise.reject("CPU_HEADROOM_CLOSED", "CPU headroom collector has closed.", error)
    }
  }

  private fun query(): Pair<Map<String, Any?>, Long?> {
    val startedNs = SystemClock.elapsedRealtimeNanos()
    val sample = mutableMapOf<String, Any?>(
      "source" to "SystemHealthManager.getCpuHeadroom(CpuHeadroomParams)",
      "scope" to "calling_process_default", "selectedTids" to null,
      "apiLevel" to Build.VERSION.SDK_INT, "osVersion" to Build.VERSION.RELEASE,
      "pid" to Process.myPid(), "sequence" to ++sequence,
      "value" to null, "rawValue" to null, "reason" to null,
      "headroomQueried" to false, "queryStage" to "api_level",
      "minimumPollingIntervalMs" to null, "pollIntervalMs" to 5000,
      "calculationType" to null, "requestedWindowMs" to null,
      "supportedWindowMinMs" to null, "supportedWindowMaxMs" to null,
      "sensorSampledAtMs" to null
    )
    try {
      if (Build.VERSION.SDK_INT < 36) {
        sample["availability"] = "unsupported"
        sample["reason"] = "requires_api_36"
        sample["pollIntervalMs"] = null
      } else {
        Api36.read(reactApplicationContext, sample)
      }
    } catch (_: UnsupportedOperationException) {
      sample["availability"] = "unsupported"
      sample["reason"] = "device_unsupported"
      sample["pollIntervalMs"] = null
    } catch (error: Exception) {
      sample["availability"] = "error"
      sample["reason"] = "query_failed:${error.javaClass.simpleName}"
    }
    val endedNs = SystemClock.elapsedRealtimeNanos()
    sample["queryStartedUptimeMs"] = startedNs / 1_000_000.0
    sample["queryFinishedUptimeMs"] = endedNs / 1_000_000.0
    sample["queryDurationMs"] = (endedNs - startedNs) / 1_000_000.0
    sample["sampledAtMs"] = System.currentTimeMillis().toDouble()
    // API/query times do not establish the underlying estimate's age.
    Log.i("WfloatCpuHeadroom", JSONObject(sample).toString())
    return Pair(sample.toMap(), (sample["pollIntervalMs"] as? Number)?.toLong())
  }

  // Isolated so older Android releases never resolve or invoke API 36 types.
  @RequiresApi(36)
  private object Api36 {
    fun read(context: Context, sample: MutableMap<String, Any?>) {
      sample["queryStage"] = "system_health_service"
      val health = context.getSystemService(SystemHealthManager::class.java)
      if (health == null) {
        sample["availability"] = "unavailable"
        sample["reason"] = "service_missing"
        return
      }
      sample["queryStage"] = "minimum_polling_interval"
      val minimum = health.cpuHeadroomMinIntervalMillis
      check(minimum in 0..Int.MAX_VALUE.toLong()) { "Invalid CPU headroom polling interval" }
      sample["minimumPollingIntervalMs"] = minimum
      sample["pollIntervalMs"] = maxOf(2000L, minimum)
      sample["queryStage"] = "calculation_window_range"
      val range = health.cpuHeadroomCalculationWindowRange
      check(range.first > 0 && range.second >= range.first) { "Invalid CPU headroom window range" }
      sample["supportedWindowMinMs"] = range.first
      sample["supportedWindowMaxMs"] = range.second
      val windowMs = 2000.coerceIn(range.first, range.second)
      val params = CpuHeadroomParams.Builder()
        .setCalculationType(CpuHeadroomParams.CPU_HEADROOM_CALCULATION_TYPE_AVERAGE)
        .setCalculationWindowMillis(windowMs)
        .build()
      sample["calculationType"] = "average"
      sample["requestedWindowMs"] = windowMs
      sample["queryStage"] = "headroom"
      sample["headroomQueried"] = true
      sample.putAll(cpuHeadroomFields(health.getCpuHeadroom(params)))
    }
  }

  override fun onHostResume() { foreground = true }
  override fun onHostPause() { foreground = false }
  override fun onHostDestroy() { foreground = false }
  @Synchronized override fun invalidate() {
    if (closed) return
    closed = true
    foreground = false
    reactApplicationContext.removeLifecycleEventListener(this)
    executor.shutdown()
    super.invalidate()
  }

  companion object {
    private val cadence = CpuHeadroomCadence<Map<String, Any?>>()
    private var sequence = 0 // Guarded by cadence across bridge instances.
  }
}
