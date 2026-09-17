package com.wfloat.bench

import android.content.Context
import android.os.Build
import android.os.PowerManager
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
import java.util.concurrent.Executors
import java.util.concurrent.RejectedExecutionException

class BenchHeadroomModule(context: ReactApplicationContext) :
  ReactContextBaseJavaModule(context), LifecycleEventListener {
  private val executor = Executors.newSingleThreadExecutor()
  @Volatile private var foreground = context.lifecycleState == LifecycleState.RESUMED
  @Volatile private var closed = false

  init { context.addLifecycleEventListener(this) }
  override fun getName() = "BenchHeadroom"

  @ReactMethod
  fun read(promise: Promise) {
    try {
      executor.execute {
        if (closed || !foreground) {
          promise.reject("HEADROOM_INACTIVE", "Headroom sampling is paused while the app is inactive.")
          return@execute
        }
        try {
          val (sample, nextReadInMs) = cadence.read(SystemClock::elapsedRealtime) { query() }
          // A cached result keeps its sequence and timestamps. Only the wait changes.
          val result = Arguments.makeNativeMap(sample)
          result.putDouble("nextReadInMs", nextReadInMs.toDouble())
          promise.resolve(result)
        } catch (error: Exception) {
          promise.reject("HEADROOM_READ_FAILED", "Could not deliver thermal headroom.", error)
        }
      }
    } catch (error: RejectedExecutionException) {
      promise.reject("HEADROOM_CLOSED", "Headroom collector has closed.", error)
    }
  }

  private fun query(): Map<String, Any?> {
    val startedNs = SystemClock.elapsedRealtimeNanos()
    val sample = mutableMapOf<String, Any?>(
      "source" to "PowerManager.getThermalHeadroom(0)",
      "forecastSeconds" to 0, "apiLevel" to Build.VERSION.SDK_INT,
      "osVersion" to Build.VERSION.RELEASE, "pid" to Process.myPid(),
      "sequence" to ++sequence, "value" to null, "rawValue" to null,
      "thermalStatusAtRead" to null, "reason" to null
    )
    try {
      val power = reactApplicationContext.getSystemService(Context.POWER_SERVICE) as? PowerManager
      when {
        Build.VERSION.SDK_INT < 30 -> {
          sample["availability"] = "unavailable"
          sample["reason"] = "requires_api_30"
        }
        power == null -> {
          sample["availability"] = "unavailable"
          sample["reason"] = "power_service_missing"
        }
        else -> {
          val value = power.getThermalHeadroom(0)
          sample["rawValue"] = value.toString()
          when {
            value.isNaN() -> {
              sample["availability"] = "unavailable"
              sample["reason"] = "not_reported"
            }
            !value.isFinite() || value < 0 -> {
              sample["availability"] = "error"
              sample["reason"] = "invalid_value"
            }
            else -> {
              sample["availability"] = "available"
              sample["value"] = value.toDouble()
            }
          }
          // Correlation only; failure here must not discard a valid headroom reading.
          sample["thermalStatusAtRead"] = try { power.currentThermalStatus } catch (_: Exception) { null }
        }
      }
    } catch (error: Exception) {
      sample["availability"] = "error"
      sample["reason"] = "query_failed:${error.javaClass.simpleName}"
    }
    val endedNs = SystemClock.elapsedRealtimeNanos()
    sample["sampledAtMs"] = System.currentTimeMillis().toDouble()
    sample["uptimeMs"] = (startedNs + (endedNs - startedNs) / 2) / 1_000_000.0
    sample["queryDurationMs"] = (endedNs - startedNs) / 1_000_000.0
    // Prototype evidence: our own metric, once per real query, never cached delivery.
    Log.i("WfloatHeadroom", JSONObject(sample).toString())
    return sample.toMap()
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
    // Shared across bridge instances/remounts in this process. Guarded by cadence's lock.
    private val cadence = HeadroomCadence<Map<String, Any?>>()
    private var sequence = 0
  }
}
