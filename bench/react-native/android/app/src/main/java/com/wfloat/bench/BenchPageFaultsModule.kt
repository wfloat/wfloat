package com.wfloat.bench

import android.os.Build
import android.os.Process
import android.os.SystemClock
import android.util.Log
import com.facebook.react.bridge.*
import com.facebook.react.common.LifecycleState
import org.json.JSONObject
import java.util.concurrent.Executors

internal object BenchPageFaultsNative {
  init { System.loadLibrary("bench_faults") }
  external fun read(): LongArray
}

class BenchPageFaultsModule(private val context: ReactApplicationContext) :
    ReactContextBaseJavaModule(context), LifecycleEventListener {
  override fun getName() = "BenchPageFaults"
  private val queue = Executors.newSingleThreadExecutor { Thread(it, "BenchPageFaults") }
  @Volatile private var foreground = context.lifecycleState == LifecycleState.RESUMED
  @Volatile private var closed = false
  private var sequence = 0L
  init { context.addLifecycleEventListener(this) }

  @ReactMethod fun read(promise: Promise) {
    try {
      check(!closed) { "Page-fault collector is closed" }
      queue.execute {
        try {
          check(!closed && foreground) { "Page-fault sampling requires the foreground app" }
          val before = SystemClock.elapsedRealtimeNanos()
          val values = BenchPageFaultsNative.read()
          val after = SystemClock.elapsedRealtimeNanos()
          val row = Arguments.createMap().apply {
            putString("kind", "android_minor_major")
            putMap("counters", Arguments.createMap().apply {
              putDouble("minorFaults", values[0].toDouble())
              putDouble("majorFaults", values[1].toDouble())
            })
            putString("source", "getrusage(RUSAGE_SELF):ru_minflt,ru_majflt")
            putDouble("pageSizeBytes", values[2].toDouble())
            putDouble("queryStartedUptimeMs", before.toDouble() / 1e6)
            putDouble("queryFinishedUptimeMs", after.toDouble() / 1e6)
            putDouble("sampledAtMs", System.currentTimeMillis().toDouble())
            putInt("processId", Process.myPid())
            putDouble("sequence", (++sequence).toDouble())
            putString("osVersion", Build.VERSION.RELEASE)
            putInt("apiLevel", Build.VERSION.SDK_INT)
          }
          val logFields = mutableMapOf<String, Any?>()
          logFields.putAll(row.toHashMap())
          Log.i("WfloatPageFaults", JSONObject(logFields).toString())
          promise.resolve(row)
        } catch (error: Exception) { promise.reject("PAGE_FAULTS_READ_FAILED", error.message, error) }
      }
    } catch (error: Exception) { promise.reject("PAGE_FAULTS_READ_FAILED", error.message, error) }
  }
  override fun onHostResume() { foreground = true }
  override fun onHostPause() { foreground = false }
  override fun onHostDestroy() { foreground = false }
  @Synchronized override fun invalidate() {
    if (closed) return
    closed = true
    context.removeLifecycleEventListener(this)
    queue.shutdown()
    super.invalidate()
  }
}
