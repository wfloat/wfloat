package com.wfloat.bench

import android.os.Debug
import android.os.Process
import android.os.Build
import android.os.SystemClock
import android.util.Log
import org.json.JSONObject
import com.facebook.react.bridge.*
import com.facebook.react.common.LifecycleState
import java.util.concurrent.Executors
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicLong

internal object BenchMemoryNative {
  init { System.loadLibrary("bench_memory") }
  external fun mallocCreate(): Long
  external fun mallocDestroy(handle: Long)
  external fun mallocHeldBytes(handle: Long): Long
  external fun mallocStep(handle: Long, operation: Int, guard: NativeMallocGuard)
  external fun create(): Long
  external fun destroy(handle: Long)
  external fun hold(handle: Long)
  external fun holdSharedDirty(handle: Long)
  external fun heldSharedRegionBytes(handle: Long): Long
  external fun release(handle: Long)
  external fun heldBytes(handle: Long): Long
  external fun heldFileBytes(handle: Long): Long
  external fun releaseSecondMapping(handle: Long)
  external fun holdSharedClean(handle: Long, directory: String)
  external fun kind(handle: Long): String
  external fun holdClean(handle: Long, directory: String)
  external fun read(): Map<String, String>
}

class BenchMemoryModule(private val context: ReactApplicationContext) :
    ReactContextBaseJavaModule(context), LifecycleEventListener {
  override fun getName() = "BenchMemory"
  private val queue = Executors.newSingleThreadScheduledExecutor { Thread(it, "BenchMemory") }
  private var handle = 0L // Accessed only on queue, including destruction.
  private var deadline: ScheduledFuture<*>? = null
  private var mallocRun = 0L
  private var nativeMallocCheck: Map<String, Any?>? = null
  private var sequence = 0L
  private val epoch = AtomicLong(0)
  @Volatile private var foreground = context.lifecycleState == LifecycleState.RESUMED
  @Volatile private var closed = false
  init { context.addLifecycleEventListener(this) }

  private fun snapshot(): WritableMap {
    check(!closed && foreground) { "Memory sampling requires the foreground app" }
    val generation = epoch.get()
    val before = SystemClock.elapsedRealtimeNanos()
    val values = BenchMemoryNative.read()
    val nativeHeap = try { nativeHeapAllocatedFields(Debug.getNativeHeapAllocatedSize()) }
      catch (failure: Exception) { nativeHeapAllocatedFields(null, "Native heap query failed: ${failure.javaClass.simpleName}") }
    val nativeHeapFree = readNativeHeapFree()
    val nativeHeapSize = readNativeHeapSize()
    val javaHeap = readJavaHeapUsed()
    val javaHeapLimit = readJavaHeapLimit()
    val artGcCount = readArtGcCount()
    val artGcTime = readArtGcTime()
    val artBlockingGcCount = readArtBlockingGcCount()
    val artBlockingGcTime = readArtBlockingGcTime()
    val artAllocatedBytes = readArtAllocatedBytes()
    val artFreedBytes = readArtFreedBytes()
    val after = SystemClock.elapsedRealtimeNanos()
    check(!closed && foreground && generation == epoch.get()) { "Memory sampling was interrupted" }
    val row = Arguments.createMap().apply {
      nativeMallocCheck?.let { putMap("nativeMallocCheck", Arguments.makeNativeMap(it)) }
      putMap("artFreedBytes", Arguments.makeNativeMap(artFreedBytes))
      putMap("artAllocatedBytes", Arguments.makeNativeMap(artAllocatedBytes))
      putMap("artBlockingGcTime", Arguments.makeNativeMap(artBlockingGcTime))
      putMap("artBlockingGcCount", Arguments.makeNativeMap(artBlockingGcCount))
      putMap("artGcTime", Arguments.makeNativeMap(artGcTime))
      putMap("artGcCount", Arguments.makeNativeMap(artGcCount))
      putMap("javaHeapLimit", Arguments.makeNativeMap(javaHeapLimit))
      putMap("javaHeapUsed", Arguments.makeNativeMap(javaHeap))
      putMap("nativeHeapSize", Arguments.makeNativeMap(nativeHeapSize))
      putMap("nativeHeapFree", Arguments.makeNativeMap(nativeHeapFree))
      putMap("nativeHeapAllocated", Arguments.makeNativeMap(nativeHeap))
      putDouble("rssBytes", values.getValue("rss.bytes").toDouble())
      putString("source", values.getValue("rss.source"))
      putMap("pss", Arguments.createMap().apply {
        putString("source", values.getValue("pss.source"))
        if (values.getValue("pss.raw").isEmpty()) {
          putNull("bytes")
          putString("error", values.getValue("pss.error"))
        } else {
          putDouble("bytes", values.getValue("pss.raw").toDouble())
          putNull("error")
        }
      })
      putMap("peakRss", Arguments.createMap().apply {
        putString("scope", "process_lifetime")
        putString("source", values.getValue("peakRss.source"))
        if (values.getValue("peakRss.raw").isEmpty()) { putNull("bytes"); putString("error", values.getValue("peakRss.error")) }
        else { putDouble("bytes", values.getValue("peakRss.raw").toDouble()); putNull("error") }
      })
      putMap("privateDirty", Arguments.createMap().apply {
        putString("source", values.getValue("privateDirty.source"))
        putString("scope", "calling_process")
        putString("unit", "bytes")
        val raw = values.getValue("privateDirty.raw").takeIf { it.isNotEmpty() }
        if (raw == null) {
          putNull("rawBytes"); putNull("bytes"); putString("error", values.getValue("privateDirty.error"))
        } else {
          putString("rawBytes", raw)
          val exact = raw.toLongOrNull()
          if (exact == null || exact < 0 || exact > 9007199254740991L) {
            putNull("bytes"); putString("error", "Private dirty memory exceeds exact JavaScript integer range")
          } else { putDouble("bytes", exact.toDouble()); putNull("error") }
        }
      })
      putMap("privateClean", Arguments.createMap().apply {
        putString("source", values.getValue("privateClean.source"))
        putString("scope", "calling_process")
        putString("unit", "bytes")
        val raw = values.getValue("privateClean.raw").takeIf { it.isNotEmpty() }
        if (raw == null) {
          putNull("rawBytes"); putNull("bytes"); putString("error", values.getValue("privateClean.error"))
        } else {
          putString("rawBytes", raw)
          val exact = raw.toLongOrNull()
          if (exact == null || exact < 0 || exact > 9007199254740991L) {
            putNull("bytes"); putString("error", "Private clean memory exceeds exact JavaScript integer range")
          } else { putDouble("bytes", exact.toDouble()); putNull("error") }
        }
      })
      putMap("sharedClean", Arguments.createMap().apply {
        putString("source", values.getValue("sharedClean.source"))
        putString("scope", "calling_process")
        putString("unit", "bytes")
        val raw = values.getValue("sharedClean.raw").takeIf { it.isNotEmpty() }
        if (raw == null) {
          putNull("rawBytes"); putNull("bytes"); putString("error", values.getValue("sharedClean.error"))
        } else {
          putString("rawBytes", raw)
          val exact = raw.toLongOrNull()
          if (exact == null || exact < 0 || exact > 9007199254740991L) {
            putNull("bytes"); putString("error", "Shared clean memory exceeds exact JavaScript integer range")
          } else { putDouble("bytes", exact.toDouble()); putNull("error") }
        }
      })
      putMap("sharedDirty", Arguments.createMap().apply {
        putString("source", values.getValue("sharedDirty.source"))
        putString("scope", "calling_process")
        putString("unit", "bytes")
        val raw = values.getValue("sharedDirty.raw").takeIf { it.isNotEmpty() }
        if (raw == null) {
          putNull("rawBytes"); putNull("bytes"); putString("error", values.getValue("sharedDirty.error"))
        } else {
          putString("rawBytes", raw)
          val exact = raw.toLongOrNull()
          if (exact == null || exact < 0 || exact > 9007199254740991L) {
            putNull("bytes"); putString("error", "Shared dirty memory exceeds exact JavaScript integer range")
          } else { putDouble("bytes", exact.toDouble()); putNull("error") }
        }
      })
      putMap("swapPss", Arguments.createMap().apply {
        putString("source", values.getValue("swapPss.source"))
        putString("scope", "calling_process")
        putString("unit", "bytes")
        val raw = values.getValue("swapPss.raw").takeIf { it.isNotEmpty() }
        if (raw == null) {
          putNull("rawBytes"); putNull("bytes"); putString("error", values.getValue("swapPss.error"))
        } else {
          putString("rawBytes", raw)
          val exact = raw.toLongOrNull()
          if (exact == null || exact < 0 || exact > 9007199254740991L) {
            putNull("bytes"); putString("error", "Proportional swap memory exceeds exact JavaScript integer range")
          } else { putDouble("bytes", exact.toDouble()); putNull("error") }
        }
      })
      putMap("anonymous", Arguments.createMap().apply {
        putString("source", values.getValue("anonymous.source"))
        putString("scope", "calling_process")
        putString("unit", "bytes")
        val raw = values.getValue("anonymous.raw").takeIf { it.isNotEmpty() }
        if (raw == null) {
          putNull("rawBytes"); putNull("bytes"); putString("error", values.getValue("anonymous.error"))
        } else {
          putString("rawBytes", raw)
          val exact = raw.toLongOrNull()
          if (exact == null || exact < 0 || exact > 9007199254740991L) {
            putNull("bytes"); putString("error", "Anonymous memory exceeds exact JavaScript integer range")
          } else { putDouble("bytes", exact.toDouble()); putNull("error") }
        }
      })
      putMap("pageTables", Arguments.createMap().apply {
        putString("source", values.getValue("pageTables.source"))
        putString("scope", "calling_process")
        putString("unit", "bytes")
        val raw = values.getValue("pageTables.raw").takeIf { it.isNotEmpty() }
        if (raw == null) {
          putNull("rawBytes"); putNull("bytes"); putString("error", values.getValue("pageTables.error"))
        } else {
          putString("rawBytes", raw)
          val exact = raw.toLongOrNull()
          if (exact == null || exact < 0 || exact > 9007199254740991L) {
            putNull("bytes"); putString("error", "Page-table memory exceeds exact JavaScript integer range")
          } else { putDouble("bytes", exact.toDouble()); putNull("error") }
        }
      })
      putMap("virtualSize", Arguments.createMap().apply {
        putString("source", values.getValue("virtualSize.source"))
        putString("scope", "calling_process")
        putString("unit", "bytes")
        val raw = values.getValue("virtualSize.raw").takeIf { it.isNotEmpty() }
        if (raw == null) {
          putNull("rawBytes"); putNull("bytes"); putString("error", values.getValue("virtualSize.error"))
        } else {
          putString("rawBytes", raw)
          val exact = raw.toLongOrNull()
          if (exact == null || exact < 0 || exact > 9007199254740991L) {
            putNull("bytes"); putString("error", "Virtual memory exceeds exact JavaScript integer range")
          } else { putDouble("bytes", exact.toDouble()); putNull("error") }
        }
      })
      putMap("locked", Arguments.createMap().apply {
        putString("source", values.getValue("locked.source"))
        putString("scope", "calling_process")
        putString("unit", "bytes")
        val raw = values.getValue("locked.raw").takeIf { it.isNotEmpty() }
        if (raw == null) {
          putNull("rawBytes"); putNull("bytes"); putString("error", values.getValue("locked.error"))
        } else {
          putString("rawBytes", raw)
          val exact = raw.toLongOrNull()
          if (exact == null || exact < 0 || exact > 9007199254740991L) {
            putNull("bytes"); putString("error", "Locked memory exceeds exact JavaScript integer range")
          } else { putDouble("bytes", exact.toDouble()); putNull("error") }
        }
      })
      putMap("peakVirtual", Arguments.createMap().apply {
        putString("source", values.getValue("peakVirtual.source"))
        putString("scope", "process_lifetime")
        putString("unit", "bytes")
        val raw = values.getValue("peakVirtual.raw").takeIf { it.isNotEmpty() }
        if (raw == null) {
          putNull("rawBytes"); putNull("bytes"); putString("error", values.getValue("peakVirtual.error"))
        } else {
          putString("rawBytes", raw)
          val exact = raw.toLongOrNull()
          if (exact == null || exact < 0 || exact > 9007199254740991L) {
            putNull("bytes"); putString("error", "Peak virtual memory exceeds exact JavaScript integer range")
          } else { putDouble("bytes", exact.toDouble()); putNull("error") }
        }
      })
      putMap("vmas", Arguments.createMap().apply {
        putString("source", values.getValue("vmas.source"))
        putString("scope", "calling_process")
        putString("unit", "regions")
        putString("aggregation", "gauge")
        val raw = values.getValue("vmas.raw").takeIf { it.isNotEmpty() }
        if (raw == null) {
          putNull("rawCount"); putNull("count"); putString("error", values.getValue("vmas.error"))
        } else {
          putString("rawCount", raw)
          val count = raw.toIntOrNull()
          if (count == null || count < 0) {
            putNull("count"); putString("error", "Invalid VMA count from native collector")
          } else { putInt("count", count); putNull("error") }
        }
      })
      putMap("anonymousPss", Arguments.createMap().apply {
        putString("source", values.getValue("anonymousPss.source"))
        putString("scope", "calling_process")
        putString("unit", "bytes")
        val raw = values.getValue("anonymousPss.raw").takeIf { it.isNotEmpty() }
        if (raw == null) {
          putNull("rawBytes"); putNull("bytes"); putString("error", values.getValue("anonymousPss.error"))
        } else {
          putString("rawBytes", raw)
          val exact = raw.toLongOrNull()
          if (exact == null || exact < 0 || exact > 9007199254740991L) {
            putNull("bytes"); putString("error", "Anonymous PSS exceeds exact JavaScript integer range")
          } else { putDouble("bytes", exact.toDouble()); putNull("error") }
        }
      })
      putMap("filePss", Arguments.createMap().apply {
        putString("source", values.getValue("filePss.source"))
        putString("scope", "calling_process")
        putString("unit", "bytes")
        val raw = values.getValue("filePss.raw").takeIf { it.isNotEmpty() }
        if (raw == null) {
          putNull("rawBytes"); putNull("bytes"); putString("error", values.getValue("filePss.error"))
        } else {
          putString("rawBytes", raw)
          val exact = raw.toLongOrNull()
          if (exact == null || exact < 0 || exact > 9007199254740991L) {
            putNull("bytes"); putString("error", "File-backed PSS exceeds exact JavaScript integer range")
          } else { putDouble("bytes", exact.toDouble()); putNull("error") }
        }
      })
      putMap("shmemPss", Arguments.createMap().apply {
        putString("source", values.getValue("shmemPss.source"))
        putString("scope", "calling_process")
        putString("unit", "bytes")
        val raw = values.getValue("shmemPss.raw").takeIf { it.isNotEmpty() }
        if (raw == null) {
          putNull("rawBytes"); putNull("bytes"); putString("error", values.getValue("shmemPss.error"))
        } else {
          putString("rawBytes", raw)
          val exact = raw.toLongOrNull()
          if (exact == null || exact < 0 || exact > 9007199254740991L) {
            putNull("bytes"); putString("error", "Shared-memory PSS exceeds exact JavaScript integer range")
          } else { putDouble("bytes", exact.toDouble()); putNull("error") }
        }
      })
      putMap("dirtyPss", Arguments.createMap().apply {
        putString("source", values.getValue("dirtyPss.source"))
        putString("scope", "calling_process")
        putString("unit", "bytes")
        val raw = values.getValue("dirtyPss.raw").takeIf { it.isNotEmpty() }
        if (raw == null) {
          putNull("rawBytes"); putNull("bytes"); putString("error", values.getValue("dirtyPss.error"))
        } else {
          putString("rawBytes", raw)
          val exact = raw.toLongOrNull()
          if (exact == null || exact < 0 || exact > 9007199254740991L) {
            putNull("bytes"); putString("error", "Dirty-page PSS exceeds exact JavaScript integer range")
          } else { putDouble("bytes", exact.toDouble()); putNull("error") }
        }
      })
      putMap("referenced", Arguments.createMap().apply {
        putString("source", values.getValue("referenced.source"))
        putString("scope", "calling_process")
        putString("unit", "bytes")
        val raw = values.getValue("referenced.raw").takeIf { it.isNotEmpty() }
        if (raw == null) {
          putNull("rawBytes"); putNull("bytes"); putString("error", values.getValue("referenced.error"))
        } else {
          putString("rawBytes", raw)
          val exact = raw.toLongOrNull()
          if (exact == null || exact < 0 || exact > 9007199254740991L) {
            putNull("bytes"); putString("error", "Referenced memory exceeds exact JavaScript integer range")
          } else { putDouble("bytes", exact.toDouble()); putNull("error") }
        }
      })
      putMap("swap", Arguments.createMap().apply {
        putString("source", values.getValue("swap.source"))
        putString("scope", "calling_process")
        putString("unit", "bytes")
        val raw = values.getValue("swap.raw").takeIf { it.isNotEmpty() }
        if (raw == null) {
          putNull("rawBytes"); putNull("bytes"); putString("error", values.getValue("swap.error"))
        } else {
          putString("rawBytes", raw)
          val exact = raw.toLongOrNull()
          if (exact == null || exact < 0 || exact > 9007199254740991L) {
            putNull("bytes"); putString("error", "Swapped memory exceeds exact JavaScript integer range")
          } else { putDouble("bytes", exact.toDouble()); putNull("error") }
        }
      })
      putMap("lazyFree", Arguments.createMap().apply {
        putString("source", values.getValue("lazyFree.source"))
        putString("scope", "calling_process")
        putString("unit", "bytes")
        val raw = values.getValue("lazyFree.raw").takeIf { it.isNotEmpty() }
        if (raw == null) {
          putNull("rawBytes"); putNull("bytes"); putString("error", values.getValue("lazyFree.error"))
        } else {
          putString("rawBytes", raw)
          val exact = raw.toLongOrNull()
          if (exact == null || exact < 0 || exact > 9007199254740991L) {
            putNull("bytes"); putString("error", "Lazy-free memory exceeds exact JavaScript integer range")
          } else { putDouble("bytes", exact.toDouble()); putNull("error") }
        }
      })
      putMap("anonHugePages", Arguments.createMap().apply {
        putString("source", values.getValue("anonHugePages.source"))
        putString("scope", "calling_process")
        putString("unit", "bytes")
        val raw = values.getValue("anonHugePages.raw").takeIf { it.isNotEmpty() }
        if (raw == null) {
          putNull("rawBytes"); putNull("bytes"); putString("error", values.getValue("anonHugePages.error"))
        } else {
          putString("rawBytes", raw)
          val exact = raw.toLongOrNull()
          if (exact == null || exact < 0 || exact > 9007199254740991L) {
            putNull("bytes"); putString("error", "Anonymous huge-page memory exceeds exact JavaScript integer range")
          } else { putDouble("bytes", exact.toDouble()); putNull("error") }
        }
      })
      putMap("filePmdMapped", Arguments.createMap().apply {
        putString("source", values.getValue("filePmdMapped.source"))
        putString("scope", "calling_process")
        putString("unit", "bytes")
        val raw = values.getValue("filePmdMapped.raw").takeIf { it.isNotEmpty() }
        if (raw == null) {
          putNull("rawBytes"); putNull("bytes"); putString("error", values.getValue("filePmdMapped.error"))
        } else {
          putString("rawBytes", raw)
          val exact = raw.toLongOrNull()
          if (exact == null || exact < 0 || exact > 9007199254740991L) {
            putNull("bytes"); putString("error", "File huge-page memory exceeds exact JavaScript integer range")
          } else { putDouble("bytes", exact.toDouble()); putNull("error") }
        }
      })
      putMap("shmemPmdMapped", Arguments.createMap().apply {
        putString("source", values.getValue("shmemPmdMapped.source"))
        putString("scope", "calling_process")
        putString("unit", "bytes")
        val raw = values.getValue("shmemPmdMapped.raw").takeIf { it.isNotEmpty() }
        if (raw == null) {
          putNull("rawBytes"); putNull("bytes"); putString("error", values.getValue("shmemPmdMapped.error"))
        } else {
          putString("rawBytes", raw)
          val exact = raw.toLongOrNull()
          if (exact == null || exact < 0 || exact > 9007199254740991L) {
            putNull("bytes"); putString("error", "Shared-memory huge-page memory exceeds exact JavaScript integer range")
          } else { putDouble("bytes", exact.toDouble()); putNull("error") }
        }
      })
      putMap("privateHugetlb", Arguments.createMap().apply {
        putString("source", values.getValue("privateHugetlb.source"))
        putString("scope", "calling_process")
        putString("unit", "bytes")
        val raw = values.getValue("privateHugetlb.raw").takeIf { it.isNotEmpty() }
        if (raw == null) {
          putNull("rawBytes"); putNull("bytes"); putString("error", values.getValue("privateHugetlb.error"))
        } else {
          putString("rawBytes", raw)
          val exact = raw.toLongOrNull()
          if (exact == null || exact < 0 || exact > 9007199254740991L) {
            putNull("bytes"); putString("error", "Private HugeTLB memory exceeds exact JavaScript integer range")
          } else { putDouble("bytes", exact.toDouble()); putNull("error") }
        }
      })
      putMap("sharedHugetlb", Arguments.createMap().apply {
        putString("source", values.getValue("sharedHugetlb.source"))
        putString("scope", "calling_process")
        putString("unit", "bytes")
        val raw = values.getValue("sharedHugetlb.raw").takeIf { it.isNotEmpty() }
        if (raw == null) {
          putNull("rawBytes"); putNull("bytes"); putString("error", values.getValue("sharedHugetlb.error"))
        } else {
          putString("rawBytes", raw)
          val exact = raw.toLongOrNull()
          if (exact == null || exact < 0 || exact > 9007199254740991L) {
            putNull("bytes"); putString("error", "Shared HugeTLB memory exceeds exact JavaScript integer range")
          } else { putDouble("bytes", exact.toDouble()); putNull("error") }
        }
      })
      putMap("ksm", Arguments.createMap().apply {
        putString("source", values.getValue("ksm.source"))
        putString("scope", "calling_process")
        putString("unit", "bytes")
        val raw = values.getValue("ksm.raw").takeIf { it.isNotEmpty() }
        if (raw == null) {
          putNull("rawBytes"); putNull("bytes"); putString("error", values.getValue("ksm.error"))
        } else {
          putString("rawBytes", raw)
          val exact = raw.toLongOrNull()
          if (exact == null || exact < 0 || exact > 9007199254740991L) {
            putNull("bytes"); putString("error", "Ksm memory exceeds exact JavaScript integer range")
          } else { putDouble("bytes", exact.toDouble()); putNull("error") }
        }
      })
      putMap("lockedResident", Arguments.createMap().apply {
        putString("source", values.getValue("lockedResident.source"))
        putString("scope", "calling_process")
        putString("unit", "bytes")
        val raw = values.getValue("lockedResident.raw").takeIf { it.isNotEmpty() }
        if (raw == null) {
          putNull("rawBytes"); putNull("bytes"); putString("error", values.getValue("lockedResident.error"))
        } else {
          putString("rawBytes", raw)
          val exact = raw.toLongOrNull()
          if (exact == null || exact < 0 || exact > 9007199254740991L) {
            putNull("bytes"); putString("error", "Locked resident memory exceeds exact JavaScript integer range")
          } else { putDouble("bytes", exact.toDouble()); putNull("error") }
        }
      })
      putString("platform", "android")
      putString("osVersion", Build.VERSION.RELEASE)
      putInt("apiLevel", Build.VERSION.SDK_INT)
      putString("clockSource", "SystemClock.elapsedRealtimeNanos")
      putDouble("sequence", (++sequence).toDouble())
      putDouble("queryStartedUptimeMs", before.toDouble() / 1e6)
      putDouble("queryFinishedUptimeMs", after.toDouble() / 1e6)
      putDouble("sampledAtMs", System.currentTimeMillis().toDouble())
      putDouble("monotonicMs", (before + (after - before) / 2).toDouble() / 1e6)
      putDouble("readDurationMs", (after - before).toDouble() / 1e6)
      putInt("processId", Process.myPid())
      putDouble("heldFileBytes", if (handle == 0L) 0.0 else BenchMemoryNative.heldFileBytes(handle).toDouble())
      putDouble("heldSharedRegionBytes", if (handle == 0L) 0.0 else BenchMemoryNative.heldSharedRegionBytes(handle).toDouble())
      putString("heldKind", if (handle == 0L) "none" else BenchMemoryNative.kind(handle))
      putDouble("heldBytes", if (handle == 0L) 0.0 else BenchMemoryNative.heldBytes(handle).toDouble())
    }
    val fields = mutableMapOf<String, Any?>(); fields.putAll(row.toHashMap())
    MemoryLogChunks.encode(JSONObject(fields).toString(), Process.myPid(), sequence).forEach {
      Log.i("WfloatMemory", it)
    }
    return row
  }

  private fun submit(promise: Promise, action: () -> Unit = {}) {
    if (closed) { promise.reject("MEMORY_CLOSED", "Memory collector is closed"); return }
    try {
      queue.execute {
        try { check(!closed) { "Memory collector is closed" }; action(); promise.resolve(snapshot()) }
        catch (error: Exception) { promise.reject("MEMORY_READ_FAILED", error.message, error) }
      }
    } catch (error: Exception) { promise.reject("MEMORY_READ_FAILED", error.message, error) }
  }
  private fun release() {
    deadline?.cancel(false)
    deadline = null
    if (handle != 0L) BenchMemoryNative.release(handle)
  }
  @ReactMethod fun nativeMallocCheck(promise: Promise) {
    val generation = epoch.get()
    submit(promise) {
      release()
      nativeMallocCheck = runNativeMallocCheck(++mallocRun, SystemClock::elapsedRealtimeNanos,
        { foreground && !closed && generation == epoch.get() }, {
          val nativeHandle = BenchMemoryNative.mallocCreate()
          check(nativeHandle != 0L) { "Could not create native allocation check" }
          object : NativeMallocOperations {
            override fun step(operation: Int, guard: NativeMallocGuard) = BenchMemoryNative.mallocStep(nativeHandle, operation, guard)
            override fun heldBytes() = BenchMemoryNative.mallocHeldBytes(nativeHandle)
            override fun close() = BenchMemoryNative.mallocDestroy(nativeHandle)
          }
        }, { listOf(try { nativeHeapAllocatedFields(Debug.getNativeHeapAllocatedSize()) }
          catch (failure: Exception) { nativeHeapAllocatedFields(null, "Native heap query failed: ${failure.javaClass.simpleName}") },
          readNativeHeapFree(), readNativeHeapSize()) })
      // One diagnostic export after cleanup, including partial/error results.
      MemoryLogChunks.encode(JSONObject(nativeMallocCheck!!).put("processId", Process.myPid()).put("sequence", mallocRun).toString(), Process.myPid(), mallocRun).forEach {
        Log.i("WfloatNativeMalloc", it)
      }
    }
  }
  @ReactMethod fun read(promise: Promise) = submit(promise)
  @ReactMethod fun hold(promise: Promise) = submit(promise) {
    check(foreground) { "Memory check requires the foreground app" }
    if (handle == 0L) handle = BenchMemoryNative.create()
    check(handle != 0L) { "Could not create memory check" }
    BenchMemoryNative.hold(handle)
    if (!foreground || closed) { release(); error("Memory check interrupted") }
    deadline = queue.schedule({ release() }, 60, TimeUnit.SECONDS)
  }
  @ReactMethod fun holdClean(promise: Promise) {
    val generation = epoch.get()
    submit(promise) {
      check(foreground && generation == epoch.get()) { "Clean memory check requires the foreground app" }
      if (handle == 0L) handle = BenchMemoryNative.create()
      check(handle != 0L) { "Could not create memory check" }
      BenchMemoryNative.holdClean(handle, context.cacheDir.absolutePath)
      if (!foreground || closed || generation != epoch.get()) { release(); error("Clean memory check interrupted") }
      deadline = queue.schedule({ release() }, 60, TimeUnit.SECONDS)
    }
  }
  @ReactMethod fun holdSharedClean(promise: Promise) {
    val generation = epoch.get()
    submit(promise) {
      check(foreground && generation == epoch.get()) { "Shared clean check requires the foreground app" }
      if (handle == 0L) handle = BenchMemoryNative.create()
      check(handle != 0L) { "Could not create memory check" }
      BenchMemoryNative.holdSharedClean(handle, context.cacheDir.absolutePath)
      if (!foreground || closed || generation != epoch.get()) { release(); error("Shared clean check interrupted") }
      deadline = queue.schedule({ release() }, 60, TimeUnit.SECONDS)
    }
  }
  @ReactMethod fun holdSharedDirty(promise: Promise) {
    val generation = epoch.get()
    submit(promise) {
      check(Build.VERSION.SDK_INT >= 26) { "Shared-memory check requires Android API 26 or later" }
      check(foreground && generation == epoch.get()) { "Shared dirty check requires the foreground app" }
      if (handle == 0L) handle = BenchMemoryNative.create()
      check(handle != 0L) { "Could not create memory check" }
      BenchMemoryNative.holdSharedDirty(handle)
      if (!foreground || closed || generation != epoch.get()) { release(); error("Shared dirty check interrupted") }
      deadline = queue.schedule({ release() }, 60, TimeUnit.SECONDS)
    }
  }
  @ReactMethod fun releaseSecondMapping(promise: Promise) {
    val generation = epoch.get()
    submit(promise) {
      check(foreground && generation == epoch.get() && handle != 0L) { "Two-mapping memory check is not active" }
      BenchMemoryNative.releaseSecondMapping(handle)
    }
  }
  @ReactMethod fun release(promise: Promise) = submit(promise) { release() }
  override fun onHostResume() { epoch.incrementAndGet(); foreground = true }
  override fun onHostPause() {
    foreground = false; epoch.incrementAndGet()
    // If invalidation won the race, its queued cleanup already owns release.
    try { if (!closed) queue.execute { release() } }
    catch (_: RejectedExecutionException) { }
  }
  override fun onHostDestroy() { onHostPause() }
  @Synchronized override fun invalidate() {
    if (closed) return
    closed = true
    context.removeLifecycleEventListener(this)
    queue.execute {
      release()
      if (handle != 0L) { BenchMemoryNative.destroy(handle); handle = 0L }
    }
    queue.shutdown()
    super.invalidate()
  }
}
