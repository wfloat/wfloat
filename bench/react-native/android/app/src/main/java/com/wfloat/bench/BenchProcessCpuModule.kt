package com.wfloat.bench

import android.os.Build
import android.os.Process
import android.os.SystemClock
import android.util.Log
import android.view.WindowManager
import com.facebook.react.bridge.*
import com.facebook.react.common.LifecycleState
import org.json.JSONObject

internal object BenchProcessCpuNative {
  init { System.loadLibrary("bench_process_cpu") }
  external fun read(): LongArray
}

class BenchProcessCpuModule(private val context: ReactApplicationContext) :
    ReactContextBaseJavaModule(context), LifecycleEventListener {
  override fun getName() = "BenchProcessCpu"
  @Volatile private var foreground = context.lifecycleState == LifecycleState.RESUMED
  @Volatile private var closed = false
  private var sequence = 0L
  private var overheadActive = false
  private var previousKeepScreenOn = false
  init { context.addLifecycleEventListener(this) }

  private fun keepAwake(active: Boolean) {
    val window = context.currentActivity?.window
    if (active) {
      check(foreground && !closed && window != null) { "Overhead check requires a foreground activity" }
      if (!overheadActive) previousKeepScreenOn = window.attributes.flags and WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON != 0
      window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
    } else if (overheadActive && !previousKeepScreenOn) window?.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
    overheadActive = active
  }
  @ReactMethod fun setOverheadActive(active: Boolean, promise: Promise) {
    context.runOnUiQueueThread {
      try { keepAwake(active); promise.resolve(null) }
      catch (error: Exception) { promise.reject("OVERHEAD_STATE_FAILED", error.message, error) }
    }
  }

  @ReactMethod fun recordOverhead(json: String, promise: Promise) {
    try {
      check(!closed && json.toByteArray(Charsets.UTF_8).size <= 3500) { "Invalid overhead record size" }
      val row = JSONObject(json)
      check(row.has("event") && row.has("runId")) { "Invalid overhead record" }
      Log.i("WfloatOverhead", row.toString())
      promise.resolve(null)
    } catch (error: Exception) { promise.reject("OVERHEAD_LOG_FAILED", error.message, error) }
  }

  @ReactMethod fun read(promise: Promise) {
    try {
      check(!closed && foreground) { "CPU sampling requires the foreground app" }
      val before = SystemClock.elapsedRealtimeNanos().toDouble() / 1e6
      val values = BenchProcessCpuNative.read()
      val after = SystemClock.elapsedRealtimeNanos().toDouble() / 1e6
      check(!closed && foreground) { "CPU sampling was interrupted" }
      val row = Arguments.createMap().apply {
        putDouble("userCpuTimeUs", values[0].toDouble())
        putDouble("systemCpuTimeUs", values[1].toDouble())
        putDouble("cpuTimeMs", (values[0] + values[1]).toDouble() / 1000.0)
        putDouble("queryStartedUptimeMs", before)
        putDouble("queryFinishedUptimeMs", after)
        putDouble("monotonicMs", before + (after - before) / 2.0)
        putString("clockSource", "SystemClock.elapsedRealtimeNanos")
        putDouble("sampledAtMs", System.currentTimeMillis().toDouble())
        putInt("processId", Process.myPid())
        putDouble("sequence", (++sequence).toDouble())
        putString("source", "getrusage(RUSAGE_SELF):ru_utime,ru_stime")
        putString("platform", "android")
        putString("osVersion", Build.VERSION.RELEASE)
        putInt("apiLevel", Build.VERSION.SDK_INT)
      }
      val fields = mutableMapOf<String, Any?>()
      fields.putAll(row.toHashMap())
      Log.i("WfloatProcessCpu", JSONObject(fields).toString())
      promise.resolve(row)
    } catch (error: Exception) {
      promise.reject("PROCESS_CPU_READ_FAILED", "Could not read process CPU time: ${error.message}", error)
    }
  }
  override fun onHostResume() { foreground = true }
  override fun onHostPause() { foreground = false; keepAwake(false) }
  override fun onHostDestroy() { foreground = false; keepAwake(false) }
  override fun invalidate() {
    closed = true
    context.runOnUiQueueThread { keepAwake(false) }
    context.removeLifecycleEventListener(this)
    super.invalidate()
  }
}
