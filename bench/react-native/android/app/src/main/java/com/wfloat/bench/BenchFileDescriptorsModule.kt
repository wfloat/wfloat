package com.wfloat.bench

import android.os.Build
import android.os.Process
import android.os.SystemClock
import android.util.Log
import com.facebook.react.bridge.*
import com.facebook.react.common.LifecycleState
import org.json.JSONObject
import java.util.UUID
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong

internal object BenchFileDescriptorsNative {
  init { System.loadLibrary("bench_file_descriptors") }
  external fun read(): IntArray
}

class BenchFileDescriptorsModule(private val context: ReactApplicationContext) :
    ReactContextBaseJavaModule(context), LifecycleEventListener {
  override fun getName() = "BenchFileDescriptors"
  private val executor = Executors.newSingleThreadExecutor { Thread(it, "BenchFileDescriptors") }
  private val pending = AtomicBoolean(false)
  private val epoch = AtomicLong(0)
  private val observationId = UUID.randomUUID().toString()
  private var sequence = 0L
  @Volatile private var foreground = context.lifecycleState == LifecycleState.RESUMED
  @Volatile private var closed = false
  init { context.addLifecycleEventListener(this) }
  private fun uptime() = SystemClock.elapsedRealtimeNanos() / 1e6

  @ReactMethod fun read(promise: Promise) {
    if (!pending.compareAndSet(false, true)) { promise.reject("FD_BUSY", "File-descriptor read already in flight"); return }
    val generation = epoch.get()
    try {
      check(!closed && foreground) { "File-descriptor sampling requires the foreground app" }
      executor.execute {
        try {
          check(!closed && foreground && generation == epoch.get()) { "File-descriptor read interrupted" }
          val start = uptime()
          var values: IntArray? = null
          var reason: String? = null
          try { values = BenchFileDescriptorsNative.read() }
          catch (error: Exception) { reason = error.message ?: error.javaClass.simpleName }
          val finish = uptime()
          val row = JSONObject().put("platform", "android").put("source", "/proc/self/fd")
            .put("scope", "calling_process").put("unit", "descriptors").put("atomicSnapshot", false)
            .put("count", values?.get(0) ?: JSONObject.NULL)
            .put("availability", if (values == null) "error" else "available")
            .put("reason", reason ?: JSONObject.NULL)
            .put("excludedCollectorDescriptor", values?.get(1) ?: JSONObject.NULL)
            .put("processId", Process.myPid()).put("observationId", observationId).put("sequence", ++sequence)
            .put("clockSource", "SystemClock.elapsedRealtimeNanos")
            .put("queryStartedUptimeMs", start).put("queryFinishedUptimeMs", finish)
            .put("sampledAtMs", System.currentTimeMillis()).put("osVersion", Build.VERSION.RELEASE)
            .put("apiLevel", Build.VERSION.SDK_INT).put("buildFingerprint", Build.FINGERPRINT)
            .put("debugBuild", BuildConfig.DEBUG)
          check(!closed && foreground && generation == epoch.get()) { "File-descriptor read interrupted" }
          val json = row.toString()
          Log.i("WfloatFileDescriptors", json)
          promise.resolve(json)
        } catch (error: Exception) { promise.reject("FD_READ_FAILED", error.message, error) }
        finally { pending.set(false) }
      }
    } catch (error: Exception) { pending.set(false); promise.reject("FD_READ_FAILED", error.message, error) }
  }
  override fun onHostResume() { epoch.incrementAndGet(); foreground = true }
  override fun onHostPause() { foreground = false; epoch.incrementAndGet() }
  override fun onHostDestroy() { onHostPause() }
  @Synchronized override fun invalidate() {
    if (closed) return
    closed = true; onHostPause(); context.removeLifecycleEventListener(this)
    executor.shutdown(); super.invalidate()
  }
}
