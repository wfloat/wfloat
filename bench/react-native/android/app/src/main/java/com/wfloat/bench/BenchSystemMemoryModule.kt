package com.wfloat.bench

import android.app.ActivityManager
import android.content.Context
import android.os.Build
import android.os.Process
import android.os.SystemClock
import android.util.Log
import com.facebook.react.bridge.*
import com.facebook.react.common.LifecycleState
import java.util.concurrent.Executors
import org.json.JSONObject

class BenchSystemMemoryModule(private val context: ReactApplicationContext) :
    ReactContextBaseJavaModule(context), LifecycleEventListener {
  override fun getName() = "BenchSystemMemory"
  private val queue = Executors.newSingleThreadExecutor { Thread(it, "BenchSystemMemory") }
  @Volatile private var foreground = context.lifecycleState == LifecycleState.RESUMED
  @Volatile private var closed = false
  private var sequence = 0L
  init { context.addLifecycleEventListener(this) }

  @ReactMethod fun read(promise: Promise) {
    try {
      check(!closed) { "System memory collector is closed" }
      queue.execute {
        try {
          check(!closed && foreground) { "System memory sampling requires the foreground app" }
          val manager = context.getSystemService(Context.ACTIVITY_SERVICE) as? ActivityManager
            ?: error("Android activity service is unavailable")
          val info = ActivityManager.MemoryInfo()
          val before = SystemClock.elapsedRealtimeNanos()
          manager.getMemoryInfo(info)
          val after = SystemClock.elapsedRealtimeNanos()
          check(!closed && foreground) { "System memory sampling was interrupted" }
          val exact = info.availMem in 0L..9007199254740991L
          val row = Arguments.createMap().apply {
            if (exact) {
              putDouble("availableBytes", info.availMem.toDouble())
              putNull("error")
            } else {
              putNull("availableBytes")
              putString("error", if (info.availMem < 0) "Android returned negative available memory"
                else "Available memory exceeds exact JavaScript integer range")
            }
            putString("rawAvailableBytes", info.availMem.toString())
            putMap("lowMemory", Arguments.createMap().apply {
              putBoolean("value", info.lowMemory)
              putString("source", "ActivityManager.getMemoryInfo().lowMemory")
              putNull("error")
            })
            putMap("lowMemoryThreshold", Arguments.createMap().apply {
              if (info.threshold in 0L..9007199254740991L) {
                putDouble("bytes", info.threshold.toDouble())
                putNull("error")
              } else {
                putNull("bytes")
                putString("error", if (info.threshold < 0) "Android returned a negative low-memory threshold"
                  else "Low-memory threshold exceeds exact JavaScript integer range")
              }
              putString("rawBytes", info.threshold.toString())
              putString("source", "ActivityManager.getMemoryInfo().threshold")
            })
            putString("source", "ActivityManager.getMemoryInfo().availMem")
            putString("scope", "system")
            putString("platform", "android")
            putString("osVersion", Build.VERSION.RELEASE)
            putInt("apiLevel", Build.VERSION.SDK_INT)
            putString("clockSource", "SystemClock.elapsedRealtimeNanos")
            putDouble("queryStartedUptimeMs", before.toDouble() / 1e6)
            putDouble("queryFinishedUptimeMs", after.toDouble() / 1e6)
            putDouble("sampledAtMs", System.currentTimeMillis().toDouble())
            putInt("processId", Process.myPid()) // Collector identity; the reading has system scope.
            putDouble("sequence", (++sequence).toDouble())
          }
          val fields = mutableMapOf<String, Any?>()
          fields.putAll(row.toHashMap())
          Log.i("WfloatSystemMemory", JSONObject(fields).toString())
          promise.resolve(row)
        } catch (error: Exception) { promise.reject("SYSTEM_MEMORY_READ_FAILED", error.message, error) }
      }
    } catch (error: Exception) { promise.reject("SYSTEM_MEMORY_READ_FAILED", error.message, error) }
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
