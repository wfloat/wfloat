package com.wfloat.bench

import android.net.TrafficStats
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

class BenchNetworkModule(private val context: ReactApplicationContext) :
    ReactContextBaseJavaModule(context), LifecycleEventListener {
  override fun getName() = "BenchNetwork"
  private val executor = Executors.newSingleThreadExecutor { Thread(it, "BenchNetwork") }
  private val pending = AtomicBoolean(false)
  private val epoch = AtomicLong(0)
  private val observationId = UUID.randomUUID().toString()
  private var sequence = 0L
  @Volatile private var foreground = context.lifecycleState == LifecycleState.RESUMED
  @Volatile private var closed = false
  init { context.addLifecycleEventListener(this) }
  private fun uptime() = SystemClock.elapsedRealtimeNanos() / 1e6

  private fun counter(rawKey: String = "rawBytes", query: () -> Long): JSONObject {
    val start = uptime()
    var raw: Long? = null
    var reason: String? = null
    var availability = "error"
    try {
      raw = query()
      availability = when {
        raw == TrafficStats.UNSUPPORTED.toLong() -> "unsupported"
        raw < 0 -> "error"
        else -> "available"
      }
      reason = when (availability) {
        "unsupported" -> "api_returned_unsupported"
        "error" -> "invalid_negative_counter"
        else -> null
      }
    } catch (error: Exception) { reason = error.javaClass.simpleName }
    return JSONObject().put(rawKey, raw?.toString() ?: JSONObject.NULL)
      .put("availability", availability).put("reason", reason ?: JSONObject.NULL)
      .put("queryStartedUptimeMs", start).put("queryFinishedUptimeMs", uptime())
  }

  @ReactMethod fun read(promise: Promise) {
    if (!pending.compareAndSet(false, true)) { promise.reject("NETWORK_BUSY", "Network read already in flight"); return }
    val generation = epoch.get()
    try {
      check(!closed && foreground) { "Network sampling requires the foreground app" }
      executor.execute {
        try {
          check(!closed && foreground && generation == epoch.get()) { "Network read interrupted" }
          val uid = Process.myUid()
          val row = JSONObject()
            .put("platform", "android").put("source", "TrafficStats.getUidRxBytes/getUidTxBytes")
            .put("scope", "calling_uid_since_boot").put("uid", uid).put("processId", Process.myPid())
            .put("observationId", observationId).put("sequence", ++sequence)
            .put("osVersion", Build.VERSION.RELEASE).put("apiLevel", Build.VERSION.SDK_INT)
            .put("buildFingerprint", Build.FINGERPRINT).put("debugBuild", BuildConfig.DEBUG)
            .put("clockSource", "SystemClock.elapsedRealtimeNanos").put("sourceSampledAtMs", JSONObject.NULL)
            .put("received", counter { TrafficStats.getUidRxBytes(uid) })
            .put("sent", counter { TrafficStats.getUidTxBytes(uid) })
            .put("packets", JSONObject()
              .put("source", "TrafficStats.getUidRxPackets/getUidTxPackets")
              .put("received", counter("rawPackets") { TrafficStats.getUidRxPackets(uid) })
              .put("sent", counter("rawPackets") { TrafficStats.getUidTxPackets(uid) }))
            .put("sampledAtMs", System.currentTimeMillis())
          check(!closed && foreground && generation == epoch.get()) { "Network read interrupted" }
          val json = row.toString()
          Log.i("WfloatNetwork", json)
          promise.resolve(json)
        } catch (error: Exception) { promise.reject("NETWORK_READ_FAILED", error.message, error) }
        finally { pending.set(false) }
      }
    } catch (error: Exception) { pending.set(false); promise.reject("NETWORK_READ_FAILED", error.message, error) }
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
