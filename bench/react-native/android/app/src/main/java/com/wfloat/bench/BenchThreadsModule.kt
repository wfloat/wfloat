package com.wfloat.bench

import android.os.Build
import android.os.Process
import android.os.SystemClock
import android.util.Log
import android.system.Os
import android.system.OsConstants
import com.facebook.react.bridge.*
import com.facebook.react.common.LifecycleState
import java.io.File
import java.util.concurrent.Executors
import org.json.JSONObject

internal object BenchThreadCaptureNative {
  init { System.loadLibrary("bench_thread_affinity") }
  external fun append(directory: String, json: ByteArray): Array<String>
}

class BenchThreadsModule(private val context: ReactApplicationContext) :
    ReactContextBaseJavaModule(context), LifecycleEventListener {
  override fun getName() = "BenchThreads"
  private val queue = Executors.newSingleThreadExecutor { Thread(it, "BenchThreads") }
  @Volatile private var foreground = context.lifecycleState == LifecycleState.RESUMED
  @Volatile private var closed = false
  private var sequence = 0L
  private var cpuSequence = 0L
  init { context.addLifecycleEventListener(this) }

  @ReactMethod fun read(promise: Promise) {
    try {
      check(!closed) { "Thread collector is closed" }
      queue.execute {
        try {
          check(!closed && foreground) { "Thread sampling requires the foreground app" }
          val before = SystemClock.elapsedRealtimeNanos()
          val count = ProcessThreadCount.parse(File("/proc/self/status").readText())
          val after = SystemClock.elapsedRealtimeNanos()
          check(!closed && foreground) { "Thread sampling was interrupted" }
          val row = Arguments.createMap().apply {
            putString("platform", "android")
            putInt("threadCount", count)
            putString("source", "/proc/self/status:Threads")
            putString("clockSource", "SystemClock.elapsedRealtimeNanos")
            putDouble("queryStartedUptimeMs", before.toDouble() / 1e6)
            putDouble("queryFinishedUptimeMs", after.toDouble() / 1e6)
            putDouble("sampledAtMs", System.currentTimeMillis().toDouble())
            putInt("processId", Process.myPid())
            putDouble("sequence", (++sequence).toDouble())
            putString("osVersion", Build.VERSION.RELEASE)
            putInt("apiLevel", Build.VERSION.SDK_INT)
          }
          val fields = mutableMapOf<String, Any?>()
          fields.putAll(row.toHashMap())
          Log.i("WfloatThreads", JSONObject(fields).toString())
          promise.resolve(row)
        } catch (error: Exception) { promise.reject("THREADS_READ_FAILED", error.message, error) }
      }
    } catch (error: Exception) { promise.reject("THREADS_READ_FAILED", error.message, error) }
  }
  @ReactMethod fun readCpu(promise: Promise) {
    try {
      check(!closed) { "Thread collector is closed" }
      queue.execute {
        try {
          check(!closed && foreground) { "Thread CPU sampling requires the foreground app" }
          val before = SystemClock.elapsedRealtimeNanos() / 1e6
          val hz = Os.sysconf(OsConstants._SC_CLK_TCK)
          check(hz in 1..9007199254740991L) { "Invalid clock tick frequency" }
          val tids = File("/proc/self/task").list()?.filter { it.matches(Regex("[1-9][0-9]*")) }?.sortedBy { it.toLong() }
            ?: error("Thread enumeration failed")
          check(tids.isNotEmpty() && tids.size <= 1024) { "Invalid or excessive thread count" }
          val threads = mutableListOf<Map<String, Any?>>()
          val errors = mutableListOf<Map<String, Any?>>()
          for (tid in tids) {
            check(!closed && foreground) { "Thread CPU sampling was interrupted" }
            var rawStat: String? = null
            try {
              val started = SystemClock.elapsedRealtimeNanos() / 1e6
              rawStat = File("/proc/self/task/$tid/stat").readText()
              val stat = ThreadCpuStat.parse(rawStat, tid)
              val finished = SystemClock.elapsedRealtimeNanos() / 1e6
              val statusStarted = SystemClock.elapsedRealtimeNanos() / 1e6
              val status = ThreadStatus.read(tid, stat.startTicks)
              val affinity = status.affinity
              val switches = status.switches
              val statusFinished = SystemClock.elapsedRealtimeNanos() / 1e6
              val getterStarted = SystemClock.elapsedRealtimeNanos() / 1e6
              val getterAffinity = ThreadGetterAffinity.read(tid, stat.startTicks)
              val getterFinished = SystemClock.elapsedRealtimeNanos() / 1e6
              threads.add(mapOf("sourceObservation" to mapOf(
                  "stat" to mapOf("text" to rawStat, "queryStartedUptimeMs" to started, "queryFinishedUptimeMs" to finished),
                  "status" to mapOf("text" to status.rawStatus, "queryStartedUptimeMs" to statusStarted, "queryFinishedUptimeMs" to statusFinished,
                    "identityCheck" to "stat_starttime_before_after", "identityVerified" to status.identityVerified, "affinityAvailable" to affinity.available, "switchesAvailable" to switches.available)),
                "threadId" to tid, "startTimeTicks" to stat.startTicks,
                "affinity" to mapOf("available" to affinity.available, "cpuList" to affinity.cpuList,
                  "cpuCount" to affinity.cpuCount?.toDouble(), "reason" to affinity.reason,
                  "queryStartedUptimeMs" to statusStarted, "queryFinishedUptimeMs" to statusFinished),
                "contextSwitches" to mapOf("available" to switches.available, "voluntaryCount" to switches.voluntaryCount,
                  "involuntaryCount" to switches.involuntaryCount, "reason" to switches.reason,
                  "queryStartedUptimeMs" to statusStarted, "queryFinishedUptimeMs" to statusFinished),
                "getterAffinity" to mapOf("available" to getterAffinity.available, "cpuIds" to getterAffinity.cpuIds,
                  "reason" to getterAffinity.reason, "queryStartedUptimeMs" to getterStarted, "queryFinishedUptimeMs" to getterFinished),
                "lastCpu" to stat.lastCpu,
                "policy" to stat.policy.toDouble(), "rtPriority" to stat.rtPriority.toDouble(),
                "priority" to stat.priority, "nice" to stat.nice,
                "name" to stat.name, "runState" to stat.runState, "userTime" to stat.user.toDouble(), "systemTime" to stat.system.toDouble(),
                "queryStartedUptimeMs" to started, "queryFinishedUptimeMs" to finished))
            } catch (cause: Exception) {
              errors.add(mapOf("threadId" to tid, "reason" to "read_failed:${cause.javaClass.simpleName}", "rawStat" to rawStat))
            }
          }
          val after = SystemClock.elapsedRealtimeNanos() / 1e6
          check(!closed && foreground) { "Thread CPU sampling was interrupted" }
          val metadata = mapOf("appVersion" to BuildConfig.VERSION_NAME, "platform" to "android", "source" to "/proc/self/task/*/stat:utime,stime,starttime",
            "runStateSource" to "/proc/self/task/*/stat:state",
            "prioritySource" to "/proc/self/task/*/stat:priority,nice",
            "priorityUnit" to "kernel_priority", "niceUnit" to "linux_nice",
            "affinitySource" to "/proc/self/task/*/status:Cpus_allowed_list", "affinityUnit" to "logical_cpu_list",
            "affinityIdentityCheck" to "stat_starttime_before_after",
            "getterAffinitySource" to "sched_getaffinity(tid)", "getterAffinityUnit" to "logical_cpu_ids",
            "getterAffinityCapacity" to 1024, "getterAffinityIdentityCheck" to "stat_starttime_before_after",
            "contextSwitchesSource" to "/proc/self/task/*/status:voluntary_ctxt_switches,nonvoluntary_ctxt_switches",
            "contextSwitchesUnit" to "switches", "contextSwitchesEncoding" to "uint64_decimal_string",
            "contextSwitchesIdentityCheck" to "stat_starttime_before_after",
            "lastCpuSource" to "/proc/self/task/*/stat:processor", "lastCpuUnit" to "logical_cpu_id",
            "schedulerSource" to "/proc/self/task/*/stat:policy,rt_priority",
            "policyUnit" to "linux_sched_policy", "rtPriorityUnit" to "linux_rt_priority",
            "counterUnit" to "clock_ticks", "counterUnitsPerSecond" to hz.toDouble(),
            "clockSource" to "SystemClock.elapsedRealtimeNanos", "queryStartedUptimeMs" to before,
            "queryFinishedUptimeMs" to after, "sampledAtMs" to System.currentTimeMillis().toDouble(),
            "processId" to Process.myPid(), "sequence" to (++cpuSequence).toDouble(),
            "osVersion" to Build.VERSION.RELEASE, "apiLevel" to Build.VERSION.SDK_INT,
            "enumeratedThreadCount" to tids.size)
          // Separate rows keep a many-thread sample below Logcat's per-message limit.
          threads.forEach { Log.i("WfloatThreadCpu", JSONObject(mapOf("event" to "thread", "processId" to Process.myPid(),
            "sequence" to cpuSequence, "thread" to it.filterKeys { key -> key != "sourceObservation" })).toString()) }
          errors.forEach { Log.i("WfloatThreadCpu", JSONObject(mapOf("event" to "error", "processId" to Process.myPid(),
            "sequence" to cpuSequence, "error" to it.filterKeys { key -> key != "rawStat" })).toString()) }
          Log.i("WfloatThreadCpu", JSONObject(metadata + mapOf("event" to "sample", "readThreadCount" to threads.size,
            "errorCount" to errors.size)).toString())
          val captureRow = metadata + mapOf("threads" to threads, "errors" to errors, "captureSchema" to 1)
          val capture = try {
            val directory = java.io.File(context.getExternalFilesDir(null) ?: context.filesDir, "source-captures")
            BenchThreadCaptureNative.append(directory.absolutePath, JSONObject(captureRow).toString().toByteArray(Charsets.UTF_8))
          } catch (failure: Throwable) { arrayOf("unavailable:${failure.javaClass.simpleName}", "") }
          promise.resolve(Arguments.makeNativeMap(metadata + mapOf("threads" to threads, "errors" to errors,
            "capture" to mapOf("state" to capture[0], "path" to capture[1]))))
        } catch (error: Exception) { promise.reject("THREAD_CPU_READ_FAILED", error.message, error) }
      }
    } catch (error: Exception) { promise.reject("THREAD_CPU_READ_FAILED", error.message, error) }
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
