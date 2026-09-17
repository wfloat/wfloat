package com.wfloat.bench

import android.os.Build
import android.util.Log
import com.facebook.react.bridge.*
import com.facebook.react.common.LifecycleState
import org.json.JSONObject
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

internal object BenchStorageIoNative {
  init { System.loadLibrary("bench_storage_io") }
  external fun read(): String
  external fun token(): Long
  external fun cancel()
  external fun run(directory: String, token: Long, reduceCaching: Boolean): String
}
class BenchStorageIoModule(private val context: ReactApplicationContext) :
    ReactContextBaseJavaModule(context), LifecycleEventListener {
  override fun getName() = "BenchStorageIo"
  private val collector = Executors.newSingleThreadExecutor { Thread(it, "BenchStorageIo") }
  private val worker = Executors.newSingleThreadExecutor { Thread(it, "BenchStorageCheck") }
  private val busy = AtomicBoolean(false)
  @Volatile private var foreground = context.lifecycleState == LifecycleState.RESUMED
  @Volatile private var closed = false
  init { context.addLifecycleEventListener(this) }
  private fun decorate(row: JSONObject): JSONObject = row.put("osVersion", Build.VERSION.RELEASE).put("apiLevel", Build.VERSION.SDK_INT)
  @ReactMethod fun read(promise: Promise) {
    try {
      check(!closed) { "Storage collector is closed" }
      collector.execute {
        try {
          check(!closed && foreground) { "Storage sampling requires the foreground app" }
          val row = decorate(JSONObject(BenchStorageIoNative.read())).toString()
          check(!closed && foreground) { "Storage sampling was interrupted" }
          Log.i("WfloatStorageIo", row); promise.resolve(row)
        } catch (error: Exception) { promise.reject("STORAGE_READ_FAILED", error.message, error) }
      }
    } catch (error: Exception) { promise.reject("STORAGE_READ_FAILED", error.message, error) }
  }
  @ReactMethod fun run(reduceCaching: Boolean, promise: Promise) {
    if (!busy.compareAndSet(false, true)) { promise.reject("STORAGE_BUSY", "Storage check is already running"); return }
    try {
      val token = BenchStorageIoNative.token()
      check(!closed && foreground) { "Storage check requires the foreground app" }
      val directory = context.cacheDir.absolutePath
      worker.execute {
        try {
          check(!closed && foreground) { "Storage check requires the foreground app" }
          val row = decorate(JSONObject(BenchStorageIoNative.run(directory, token, reduceCaching)))
          check(!closed && foreground) { "Storage check was interrupted" }
          val snapshots = row.getJSONArray("snapshots")
          for (i in 0 until snapshots.length()) decorate(snapshots.getJSONObject(i))
          val json = row.toString()
          // Keep each log line below logcat's payload limit.
          val parts = json.chunked(600)
          parts.forEachIndexed { i, part -> Log.i("WfloatStorageCheck", "pid=${android.os.Process.myPid()} run=${row.getLong("runSequence")} part=${i + 1}/${parts.size} $part") }
          promise.resolve(json)
        } catch (error: Exception) { promise.reject("STORAGE_CHECK_FAILED", error.message, error) }
        finally { busy.set(false) }
      }
    } catch (error: Exception) { busy.set(false); promise.reject("STORAGE_CHECK_FAILED", error.message, error) }
  }
  @ReactMethod fun cancel(promise: Promise) { BenchStorageIoNative.cancel(); promise.resolve(null) }
  override fun onHostResume() { foreground = true }
  override fun onHostPause() { foreground = false; BenchStorageIoNative.cancel() }
  override fun onHostDestroy() { onHostPause() }
  @Synchronized override fun invalidate() {
    if (closed) return
    closed = true; BenchStorageIoNative.cancel()
    context.removeLifecycleEventListener(this); collector.shutdown(); worker.shutdown(); super.invalidate()
  }
}
