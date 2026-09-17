package com.wfloat.bench

import android.util.Log
import android.os.Build
import com.facebook.react.bridge.*
import com.facebook.react.common.LifecycleState
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean
import org.json.JSONObject

internal object BenchFileFaultProbeNative {
  init { System.loadLibrary("bench_faults") }
  external fun token(): Long
  external fun cancel()
  external fun run(directory: String, token: Long): String
}

class BenchFileFaultProbeModule(private val context: ReactApplicationContext) :
    ReactContextBaseJavaModule(context), LifecycleEventListener {
  override fun getName() = "BenchFileFaultProbe"
  private val queue = Executors.newSingleThreadExecutor { Thread(it, "BenchFileFaultProbe") }
  private val busy = AtomicBoolean(false)
  @Volatile private var foreground = context.lifecycleState == LifecycleState.RESUMED
  @Volatile private var closed = false
  init { context.addLifecycleEventListener(this) }

  @ReactMethod fun run(promise: Promise) {
    if (!busy.compareAndSet(false, true)) {
      promise.reject("FILE_PROBE_BUSY", "A file probe is already running"); return
    }
    try {
      val token = BenchFileFaultProbeNative.token()
      check(!closed && foreground) { "The file probe requires the foreground app" }
      val directory = context.cacheDir.absolutePath
      queue.execute {
        try {
          check(!closed && foreground) { "The file probe requires the foreground app" }
          val json = JSONObject(BenchFileFaultProbeNative.run(directory, token))
            .put("osVersion", Build.VERSION.RELEASE).put("apiLevel", Build.VERSION.SDK_INT).toString()
          Log.i("WfloatFileFaultProbe", json)
          promise.resolve(json)
        } catch (error: Exception) { promise.reject("FILE_PROBE_FAILED", error.message, error) }
        finally { busy.set(false) }
      }
    } catch (error: Exception) {
      busy.set(false)
      promise.reject("FILE_PROBE_FAILED", error.message, error)
    }
  }
  @ReactMethod fun cancel(promise: Promise) {
    BenchFileFaultProbeNative.cancel()
    promise.resolve(null)
  }
  override fun onHostResume() { foreground = true }
  override fun onHostPause() { foreground = false; BenchFileFaultProbeNative.cancel() }
  override fun onHostDestroy() { onHostPause() }
  @Synchronized override fun invalidate() {
    if (closed) return
    closed = true
    BenchFileFaultProbeNative.cancel()
    context.removeLifecycleEventListener(this)
    queue.shutdown()
    super.invalidate()
  }
}
