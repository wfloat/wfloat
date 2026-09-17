package com.wfloat.bench

import android.content.Context
import android.os.Build
import android.os.PowerManager
import com.facebook.react.bridge.*
import com.facebook.react.common.LifecycleState
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit
import org.json.JSONObject

internal object BenchCpuNative {
  init { System.loadLibrary("bench_cpu") }
  external fun start(workers: Int, duration: Long, withGpu: Boolean): Boolean
  external fun stop(reason: Int)
  external fun observe(thermal: Int, foreground: Boolean)
  external fun snapshot(): String
}

class BenchCpuModule(private val context: ReactApplicationContext) :
    ReactContextBaseJavaModule(context), LifecycleEventListener {
  override fun getName() = "BenchCpu"
  @Volatile private var foreground = context.lifecycleState == LifecycleState.RESUMED
  private val monitor = Executors.newSingleThreadScheduledExecutor { Thread(it, "BenchCpuThermalMonitor") }
  private var monitoring: ScheduledFuture<*>? = null

  init { context.addLifecycleEventListener(this) }

  private fun thermal(): Int {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return -1
    val power = context.getSystemService(Context.POWER_SERVICE) as? PowerManager ?: return -1
    return power.currentThermalStatus
  }

  private fun status(): WritableMap {
    val json = JSONObject(BenchCpuNative.snapshot())
    return Arguments.createMap().apply {
      putBoolean("running", json.getBoolean("running"))
      putBoolean("stopping", json.getBoolean("stopping"))
      putInt("workers", json.getInt("workers"))
      putInt("targetWorkers", json.getInt("targetWorkers"))
      putDouble("elapsedMs", json.getDouble("elapsedMs"))
      putDouble("blocks", json.getDouble("blocks"))
      putDouble("checksum", json.getDouble("checksum"))
      putString("reason", json.getString("reason"))
      for (key in listOf("gpuEnabled", "gpuActive")) putBoolean(key, json.getBoolean(key))
      for (key in listOf("gpuBatches", "gpuChecksum", "gpuLastBatchMs")) putDouble(key, json.getDouble(key))
      for (key in listOf("gpuRenderer", "gpuError")) putString(key, json.getString(key))
    }
  }

  @ReactMethod fun start(promise: Promise) = startWorkload(false, promise)
  @ReactMethod fun startCombined(promise: Promise) = startWorkload(true, promise)
  @ReactMethod fun startSourceLoad(promise: Promise) = startWorkload(true, promise, 45000)
  @ReactMethod fun startEnergyProbe(promise: Promise) = startWorkload(false, promise, 120000)

  private fun startWorkload(withGpu: Boolean, promise: Promise, durationMs: Long = 600000) {
    try {
      check(foreground) { "CPU stress requires the foreground app" }
      check(thermal() == PowerManager.THERMAL_STATUS_NONE) { "CPU stress requires an available NONE thermal reading" }
      // Leave scheduler capacity for GPU submission/driver work in combined mode.
      val cores = Runtime.getRuntime().availableProcessors()
      val workers = (cores - if (withGpu) 1 else 0).coerceIn(1, 64)
      check(BenchCpuNative.start(workers, durationMs, withGpu)) {
        "CPU stress is already running"
      }
      monitoring?.cancel(false)
      monitoring = monitor.scheduleAtFixedRate({
        try { BenchCpuNative.observe(thermal(), foreground) }
        catch (_: Exception) { BenchCpuNative.observe(-1, foreground) }
        // A source probe has no JS polling loop to cancel this monitor after
        // its native deadline. Stop monitoring once native workers finish too.
        try {
          val current = JSONObject(BenchCpuNative.snapshot())
          if (!current.getBoolean("running") && !current.getBoolean("stopping")) monitoring?.cancel(false)
        } catch (_: Exception) { BenchCpuNative.stop(2) }
      }, 0, 500, TimeUnit.MILLISECONDS)
      promise.resolve(status())
    } catch (error: Exception) {
      promise.reject("CPU_START_FAILED", error.message, error)
    }
  }

  @ReactMethod fun read(promise: Promise) {
    try {
      val current = status()
      if (!current.getBoolean("running")) monitoring?.cancel(false)
      promise.resolve(current)
    }
    catch (error: Exception) { promise.reject("CPU_READ_FAILED", error.message, error) }
  }
  @ReactMethod fun stop(reason: Double, promise: Promise) {
    BenchCpuNative.stop(reason.toInt())
    promise.resolve(null)
  }
  override fun onHostResume() { foreground = true }
  override fun onHostPause() { foreground = false; BenchCpuNative.stop(1) }
  override fun onHostDestroy() { foreground = false; BenchCpuNative.stop(2) }
  override fun invalidate() {
    BenchCpuNative.stop(2)
    monitoring?.cancel(false)
    monitor.shutdownNow()
    context.removeLifecycleEventListener(this)
    super.invalidate()
  }
}
