package com.wfloat.bench

import android.os.Build
import android.os.Process
import android.os.SystemClock
import android.util.Log
import com.facebook.react.bridge.*
import com.facebook.react.common.LifecycleState
import org.json.JSONObject

internal object BenchContextSwitchesNative {
  init { System.loadLibrary("bench_context_switches") }
  external fun read(): LongArray
  external fun probeState(): DoubleArray
  external fun token(): Long
  external fun start(token: Long)
  external fun cancel()
}

class BenchContextSwitchesModule(private val context: ReactApplicationContext) :
    ReactContextBaseJavaModule(context), LifecycleEventListener {
  override fun getName() = "BenchContextSwitches"
  @Volatile private var foreground = context.lifecycleState == LifecycleState.RESUMED
  @Volatile private var closed = false
  private var sequence = 0L
  init { context.addLifecycleEventListener(this) }
  @ReactMethod fun read(promise: Promise) {
    try {
      check(!closed && foreground) { "Context-switch sampling requires the foreground app" }
      val before = SystemClock.elapsedRealtimeNanos().toDouble() / 1e6
      val values = BenchContextSwitchesNative.read()
      val after = SystemClock.elapsedRealtimeNanos().toDouble() / 1e6
      check(!closed && foreground) { "Context-switch sampling was interrupted" }
      val probe = BenchContextSwitchesNative.probeState()
      val row = Arguments.createMap().apply {
        putString("platform", "android")
        putString("source", "getrusage(RUSAGE_SELF):ru_nvcsw,ru_nivcsw")
        putString("clockSource", "SystemClock.elapsedRealtimeNanos")
        putMap("counters", Arguments.createMap().apply {
          putDouble("total", values[0].toDouble())
          putDouble("voluntary", values[1].toDouble())
          putDouble("involuntary", values[2].toDouble())
        })
        putDouble("queryStartedUptimeMs", before); putDouble("queryFinishedUptimeMs", after)
        putDouble("sampledAtMs", System.currentTimeMillis().toDouble())
        putInt("processId", Process.myPid()); putDouble("sequence", (++sequence).toDouble())
        putString("osVersion", Build.VERSION.RELEASE); putInt("apiLevel", Build.VERSION.SDK_INT)
        putMap("probe", Arguments.createMap().apply {
          putBoolean("running", probe[0] != 0.0); putDouble("wakes", probe[1])
          putDouble("elapsedMs", probe[2]); putDouble("runSequence", probe[3])
        })
      }
      val fields = mutableMapOf<String, Any?>(); fields.putAll(row.toHashMap())
      Log.i("WfloatContextSwitches", JSONObject(fields).toString())
      promise.resolve(row)
    } catch (error: Exception) { promise.reject("CONTEXT_SWITCHES_FAILED", error.message, error) }
  }
  @ReactMethod fun startProbe(promise: Promise) {
    try {
      val token = BenchContextSwitchesNative.token()
      check(!closed && foreground) { "Wait/wake check requires the foreground app" }
      BenchContextSwitchesNative.start(token)
      promise.resolve(null)
    } catch (error: Exception) { promise.reject("WAIT_WAKE_FAILED", error.message, error) }
  }
  @ReactMethod fun stopProbe(promise: Promise) { BenchContextSwitchesNative.cancel(); promise.resolve(null) }
  override fun onHostResume() { foreground = true }
  override fun onHostPause() { foreground = false; BenchContextSwitchesNative.cancel() }
  override fun onHostDestroy() { onHostPause() }
  override fun invalidate() {
    closed = true; BenchContextSwitchesNative.cancel()
    context.removeLifecycleEventListener(this); super.invalidate()
  }
}
