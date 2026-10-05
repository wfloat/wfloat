package com.wfloat

import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.module.annotations.ReactModule
import org.json.JSONObject
import java.util.concurrent.CancellationException
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

@ReactModule(name = WfloatNextModule.NAME)
class WfloatNextModule(context: ReactApplicationContext) : NativeWfloatNextSpec(context) {
  companion object { const val NAME = "WfloatNext" }
  private val audioWorkers = Executors.newSingleThreadExecutor()
  private val workers = Executors.newCachedThreadPool()
  private val requests = ConcurrentHashMap<String, AtomicBoolean>()
  private val instances = ConcurrentHashMap<String, java.util.concurrent.locks.ReentrantLock>()
  private val loadedPaths = ConcurrentHashMap<String, List<String>>()
  private val assets = NextAssets(context)
  private val closed = AtomicBoolean(false)
  private val audio = NextAudio(context, ::event)
  private val runtimeLock = Any()
  private var runtime: Long = 0
  private fun runtime(): Long = synchronized(runtimeLock) {
    if (runtime == 0L) {
      System.loadLibrary("wfloat-next-jni")
      runtime = nativeCreate()
      check(runtime != 0L) { "Could not create common runtime" }
    }
    runtime
  }
  override fun getName() = NAME
  private fun event(id: String, value: JSONObject) {
    if (closed.get()) return
    val map = Arguments.createMap()
    map.putString("requestId", id)
    map.putString("payload", value.toString())
    emitOnEvent(map)
  }
  private fun nativeEvent(id: String, payload: String) {
    if (closed.get()) return
    val map = Arguments.createMap()
    map.putString("requestId", id)
    map.putString("payload", payload)
    emitOnEvent(map)
  }
  override fun request(requestId: String, command: String, promise: Promise) {
    if (closed.get()) { promise.reject("E_CLOSED", "WfloatNext is invalidated"); return }
    val cancelled = AtomicBoolean(false)
    if (requests.putIfAbsent(requestId, cancelled) != null) { promise.reject("E_REQUEST", "Duplicate active requestId"); return }
    val parsed = try { JSONObject(command) } catch (e: Exception) {
      requests.remove(requestId, cancelled); promise.reject("E_COMMAND", "Invalid command JSON", e); return
    }
    val executor = if (parsed.optString("op").startsWith("mic") || parsed.optString("op").startsWith("playback")) audioWorkers else workers
    try { executor.execute {
      try {
        if (cancelled.get()) throw CancellationException("Request cancelled")
        val c = parsed
        val result: Any = when (val op = c.getString("op")) {
          "assetDownload" -> assets.download(c, cancelled) { event(requestId, it) }
          "assetAssemble" -> assets.assemble(c, cancelled)
          "assetStat" -> assets.stat(c.getString("key"), if (c.has("sha256")) c.getString("sha256") else null, if (c.has("sizeBytes")) c.getLong("sizeBytes") else null)
          "assetDelete" -> { assets.delete(c.getString("key")); JSONObject.NULL }
          "prepareEspeak" -> assets.prepareEspeak(c, cancelled)
          "decodeAudio" -> NextAudioDecoder.decode(reactApplicationContext, c.getString("uri"), cancelled)
          "playbackPrepare" -> {
            val value = audio.command(requestId, c)
            if (cancelled.get()) {
              audio.command(requestId, JSONObject().put("op", "playbackClose").put("playbackId", c.getString("playbackId")))
              throw CancellationException("Playback preparation cancelled")
            }
            value
          }
          "micStart", "micStop", "micDrain", "micAck", "playbackStart", "playbackAppend", "playbackPause", "playbackClose", "playbackPosition" -> audio.command(requestId, c)
          else -> {
            require(op in setOf("load", "unload", "prepare", "synthesize", "configure", "transcribe", "openStream", "resetStream", "closeStream", "pushStream", "resetVad", "scoreVad", "count", "schema", "generateRound")) { "Unknown operation: $op" }
            val id = c.getString("instanceId")
            val lock = instances.getOrPut(id) { java.util.concurrent.locks.ReentrantLock() }
            while (!lock.tryLock(10, java.util.concurrent.TimeUnit.MILLISECONDS)) {
              if (cancelled.get()) throw CancellationException("Request cancelled")
            }
            try {
              if (cancelled.get()) throw CancellationException("Request cancelled")
              val paths = if (op == "load") {
                require(!loadedPaths.containsKey(id)) { "Instance is already loaded" }
                val values = c.getJSONObject("paths")
                values.keys().asSequence().map { values.getString(it) }.filter { it.startsWith("/") }.toList()
              } else emptyList()
              if (op == "load") assets.pin(paths)
              try {
                val value = nativeRequest(runtime(), command, requestId, cancelled)
                if (op == "load") {
                  loadedPaths[id] = paths
                  if (c.optString("task") == "tts") {
                    val values = c.getJSONObject("paths")
                    val espeak = values.optString("espeak_data", values.optString("dataDir", ""))
                    if (espeak.startsWith("/")) assets.pinEspeakForProcess(espeak)
                  }
                }
                if (op == "unload") loadedPaths.remove(id)?.let { assets.unpin(it) }
                // Runtime already returns a JSON value, including scalar and null results.
                requests.remove(requestId, cancelled)
                promise.resolve(value)
                return@execute
              } catch (e: Throwable) {
                if (op == "load") assets.unpin(paths)
                throw e
              }
            } finally { lock.unlock() }
          }
        }
        requests.remove(requestId, cancelled)
        promise.resolve(result.toString())
      } catch (e: Throwable) {
        requests.remove(requestId, cancelled)
        promise.reject(if (e is CancellationException || cancelled.get()) "E_CANCELLED" else "E_WFLOAT_NEXT", e.message, e)
      } finally { requests.remove(requestId, cancelled) }
    } } catch (e: java.util.concurrent.RejectedExecutionException) {
      requests.remove(requestId, cancelled)
      promise.reject("E_CLOSED", "WfloatNext is invalidated", e)
    }
  }
  override fun cancel(requestId: String) { requests[requestId]?.set(true) }
  override fun invalidate() {
    if (!closed.compareAndSet(false, true)) return
    requests.values.forEach { it.set(true) }
    audio.close()
    workers.shutdown()
    audioWorkers.shutdown()
    // Do not free Runtime while a native request still owns it; cancellation remains reachable.
    Thread({
      while (!audioWorkers.awaitTermination(1, java.util.concurrent.TimeUnit.DAYS)) { }
      while (!workers.awaitTermination(1, java.util.concurrent.TimeUnit.DAYS)) { }
      synchronized(runtimeLock) { if (runtime != 0L) nativeDestroy(runtime); runtime = 0 }
      loadedPaths.values.forEach { assets.unpin(it) }; loadedPaths.clear()
    }, "WfloatNextTeardown").apply { isDaemon = true; start() }
    super.invalidate()
  }
  private external fun nativeCreate(): Long
  private external fun nativeRequest(handle: Long, command: String, requestId: String, cancelled: AtomicBoolean): String
  private external fun nativeDestroy(handle: Long)
}
