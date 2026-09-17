package com.wfloat.bench

import android.app.ActivityManager
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.net.TrafficStats
import android.os.*
import android.system.Os
import android.system.OsConstants
import android.util.Log
import com.facebook.react.bridge.*
import com.facebook.react.common.LifecycleState
import org.json.JSONObject
import org.json.JSONArray
import java.io.File

internal object BenchSignalsNative {
  init { System.loadLibrary("bench_signals") }
  external fun append(directory: String, json: ByteArray): Array<String>
  external fun rusage(): LongArray
  external fun pageProbe(): String
  external fun resources(): String
  external fun descriptors(): String
  external fun kgslCounters(): String
  external fun gpuProbe(): String
  external fun glesProbe(): String
  external fun networkDriver(name:String): String
  external fun socketProbe(): String
  external fun netlinkInterfaces(stats:Boolean,extended:Boolean): String
  external fun bpfGpuMemory(): String
  external fun perfProbe(): String
  external fun schedulerAttributes(tid: Int): String
}

// Deliberately source-shaped: no cross-platform units normalization or dashboard
// per field. Read-only probes preserve access failures beside successful sources.
class BenchSignalsModule(private val context: ReactApplicationContext) :
  ReactContextBaseJavaModule(context), LifecycleEventListener, android.content.ComponentCallbacks2 {
  override fun getName() = "BenchSignals"
  @Volatile private var foreground = context.lifecycleState == LifecycleState.RESUMED
  @Volatile private var closed = false
  private var sequence = 0L
  private var pageProbe=JSONObject().put("state","not_requested")
  private var kgslCounters=JSONObject().put("state","not_requested")
  private var gpuProbe=JSONObject().put("state","not_requested")
  private var socketProbe=JSONObject().put("state","not_requested")
  private val thermalEvents=ThermalEventSources(context)
  private val powerEvents=PowerEventSources(context)
  private val temperatureSensors=TemperatureSensorSources(context)
  private var perfProbe=JSONObject().put("state","not_requested")
  private val frameProbe=FrameSignalProbe()
  private val trace=SystemTraceCapture(context)
  private val systemProfileEvents=if(Build.VERSION.SDK_INT>=35)SystemProfileEvents(context) else null
  private val storageSources=StorageSources(context)
  private val trimEvents=java.util.ArrayDeque<Map<String,Any>>()
  private var trimCount=0L
  init { context.addLifecycleEventListener(this);context.registerComponentCallbacks(this);if(foreground){thermalEvents.start();powerEvents.start();temperatureSensors.start()} }
  override fun onConfigurationChanged(config:android.content.res.Configuration) {}
  override fun onLowMemory() { recordTrim(-1) }
  override fun onTrimMemory(level:Int) { recordTrim(level) }
  private fun recordTrim(level:Int) = synchronized(trimEvents) {
    ++trimCount;if(trimEvents.size>=64) trimEvents.removeFirst()
    trimEvents.addLast(mapOf("level" to level,"receivedAtMs" to System.currentTimeMillis(),"uptimeMs" to SystemClock.elapsedRealtime()))
  }
  private fun nativeParcel(value:Parcelable):JSONObject {
    val parcel=Parcel.obtain()
    try {value.writeToParcel(parcel,0);val bytes=parcel.marshall()
      return JSONObject().put("format",value.javaClass.name+" Parcelable").put("sdkInt",Build.VERSION.SDK_INT)
        .put("byteCount",bytes.size).put("base64",android.util.Base64.encodeToString(bytes,android.util.Base64.NO_WRAP))
    } finally {parcel.recycle()}
  }
  private fun now() = SystemClock.elapsedRealtimeNanos().toDouble()/1e6
  @ReactMethod fun runPerfProbe(promise:Promise) {
    try {check(foreground && !closed) { "Perf probe requires foreground" };val began=System.currentTimeMillis();perfProbe=JSONObject(BenchSignalsNative.perfProbe()).put("requestedAtMs",began).put("receivedAtMs",System.currentTimeMillis());promise.resolve(null)}
    catch(e:Exception) {promise.reject("PERF_PROBE_FAILED",e.message,e)}
  }
  @ReactMethod fun runFrameProbe(promise:Promise) {
    try {check(foreground && !closed) { "Frame probe requires foreground" };val window=currentActivity?.window?:error("No current activity window");frameProbe.start(window);promise.resolve(null)}
    catch(e:Exception) {promise.reject("FRAME_PROBE_FAILED",e.message,e)}
  }
  @ReactMethod fun runSocketProbe(promise:Promise) {
    try {check(foreground && !closed) { "Socket probe requires foreground" };val began=System.currentTimeMillis();socketProbe=JSONObject(BenchSignalsNative.socketProbe()).put("requestedAtMs",began)
      val interfaces=try {java.net.NetworkInterface.getNetworkInterfaces()?.toList()?.map{it.name}?:emptyList()}catch(e:Exception){socketProbe.put("driverEnumerationError",e.toString());emptyList()}
      val driverStart=SystemClock.elapsedRealtimeNanos();var driverLimited=interfaces.size>32
      val drivers=JSONArray();for(name in interfaces.take(32)){if(SystemClock.elapsedRealtimeNanos()-driverStart>2_000_000_000L){driverLimited=true;break};drivers.put(JSONObject(BenchSignalsNative.networkDriver(name)))}
      socketProbe.put("driverInterfaces",drivers).put("driverInterfaceLimitReached",driverLimited).put("receivedAtMs",System.currentTimeMillis());promise.resolve(null)}
    catch(e:Exception) {promise.reject("SOCKET_PROBE_FAILED",e.message,e)}
  }
  @Volatile private var glesProbe=JSONObject().put("state","not_requested")
  @ReactMethod fun runGpuProbe(promise:Promise) {
    try {check(foreground && !closed) { "GPU probe requires foreground" };val kgslBegan=System.currentTimeMillis();kgslCounters=JSONObject().put("before",JSONObject(BenchSignalsNative.kgslCounters()).put("requestedAtMs",kgslBegan).put("receivedAtMs",System.currentTimeMillis()));val began=System.currentTimeMillis();gpuProbe=JSONObject(BenchSignalsNative.gpuProbe()).put("requestedAtMs",began).put("receivedAtMs",System.currentTimeMillis());val glBegan=System.currentTimeMillis();glesProbe=JSONObject(BenchSignalsNative.glesProbe()).put("requestedAtMs",glBegan).put("receivedAtMs",System.currentTimeMillis());val kgslAfter=System.currentTimeMillis();kgslCounters.put("after",JSONObject(BenchSignalsNative.kgslCounters()).put("requestedAtMs",kgslAfter).put("receivedAtMs",System.currentTimeMillis()));promise.resolve(null)}
    catch(e:Exception) {promise.reject("GPU_PROBE_FAILED",e.message,e)}
  }
  @ReactMethod fun runPageProbe(promise:Promise) {
    try {check(foreground && !closed) { "Page probe requires foreground" };val began=System.currentTimeMillis();pageProbe=JSONObject(BenchSignalsNative.pageProbe()).put("requestedAtMs",began).put("receivedAtMs",System.currentTimeMillis());promise.resolve(null)}
    catch(e:Exception) {promise.reject("PAGE_PROBE_FAILED",e.message,e)}
  }
  @ReactMethod fun startProfile(kind:Int,promise:Promise) {
    try {check(foreground && !closed) { "Profile requires foreground" };trace.start(kind);promise.resolve(null)}
    catch(e:Exception) {promise.reject("PROFILE_FAILED",e.message,e)}
  }
  @ReactMethod fun setSystemProfilingTriggers(enabled:Boolean,promise:Promise) {
    try {(systemProfileEvents?:error("System profiling requires API 35+")).setTriggers(enabled);promise.resolve(null)}catch(e:Exception){promise.reject("SYSTEM_PROFILE_TRIGGERS_FAILED",e.message,e)}
  }
  @ReactMethod fun requestRunningSystemTrace(promise:Promise) {
    try {(systemProfileEvents?:error("System profiling requires API 35+")).requestRunningTrace();promise.resolve(null)}catch(e:Exception){promise.reject("RUNNING_TRACE_FAILED",e.message,e)}
  }
  @ReactMethod fun startTrace(promise:Promise) {
    try {check(foreground && !closed) { "Trace requires foreground" };trace.start();promise.resolve(null)}
    catch(e:Exception) {promise.reject("TRACE_FAILED",e.message,e)}
  }
  @ReactMethod fun read(promise: Promise) {
    try {
      check(foreground && !closed) { "Source sampling requires foreground" }
      val sources = JSONArray()
      fun source(name: String, scope: String, read: () -> JSONObject) {
        val start = now()
        val row = JSONObject().put("source", name).put("scope", scope).put("queryStartedUptimeMs", start)
        try { row.put("values", read()).put("error", JSONObject.NULL) }
        catch (e: Exception) { row.put("values", JSONObject.NULL).put("error", "${e.javaClass.simpleName}: ${e.message}") }
        row.put("queryFinishedUptimeMs", now()); sources.put(row)
      }
      fun text(path: String, scope: String, limit:Int=262144) = source(path, scope) {
        // Bound individual pseudo-file reads. Truncated text is never presented as complete.
        val bytes = File(path).inputStream().use { input ->
          val buffer=ByteArray(limit+1); var used=0
          while(used<buffer.size) { val n=input.read(buffer,used,buffer.size-used);if(n<0) break;used+=n }
          buffer.copyOf(used)
        }
        JSONObject().put("text", bytes.copyOf(minOf(bytes.size,limit)).toString(Charsets.UTF_8))
          .put("truncated", bytes.size > limit)
      }
      source("BenchCpu_workload_status", "app_owned_validation_workload") {JSONObject(BenchCpuNative.snapshot())}
      for (name in listOf("stat", "status", "statm", "maps", "numa_maps", "cgroup", "smaps_rollup", "time_in_state", "io", "schedstat", "sched", "limits", "oom_score", "oom_score_adj"))
        text("/proc/self/$name", if (name == "sched" || name == "schedstat") "main_thread" else "process")
      text("/proc/self/smaps","per_mapping",4194304)
      for(name in listOf("mountinfo","mounts","timers","personality","wchan","syscall","stack","latency","ksm_stat","ksm_merging_pages","autogroup","arch_status")) text("/proc/self/$name","process_or_main_thread")
      source("/proc/self/task/*/full_records", "per_thread") {ProcDetailSources.threadRecords()}
      source("rtnetlink_extended_statistics", "system_network_interfaces") {JSONObject(BenchSignalsNative.netlinkInterfaces(true,true))}
      source("rtnetlink_statistics", "system_network_interfaces") {JSONObject(BenchSignalsNative.netlinkInterfaces(true,false))}
      source("rtnetlink_interfaces", "system_network_interfaces") {JSONObject(BenchSignalsNative.netlinkInterfaces(false,false))}
      source("bpf_gpu_memory", "own_process_and_global_gpu_memory") {JSONObject(BenchSignalsNative.bpfGpuMemory())}
      source("driver_interface_catalog", "kernel_driver_source_discovery") {DriverCatalogSources.read()}
      source("cached_cellular_signal", "cached_modem_link_quality") {CellularSignalSources.read(context)}
      source("uid_kernel_accounting", "own_uid_including_exited_processes") {UidAccountingSources.read()}
      source("cgroup_controller_sources", "reported_control_groups") {CgroupSources.read()}
      source("/proc/self/fdinfo/*", "process_descriptors") {ProcDetailSources.descriptors()}
      source("perf_event_open_probe", "explicit_probe_last_result") {JSONObject(perfProbe.toString())}
      source("SensorManager_temperature_sources", "optional_temperature_sensors") {temperatureSensors.snapshot()}
      source("power_battery_callbacks", "foreground_os_event_delivery") {powerEvents.snapshot()}
      source("PowerManager_thermal_callbacks", "foreground_os_event_delivery") {thermalEvents.snapshot()}
      source("FrameMetrics_Choreographer_probe", "explicit_probe_last_result") {frameProbe.snapshot()}
      source("KGSL_existing_performance_counters", "explicit_driver_snapshot") {JSONObject(kgslCounters.toString())}
      source("TCP_loopback_probe", "explicit_probe_last_result") {JSONObject(socketProbe.toString())}
      source("GLES_explicit_probe", "explicit_probe_last_result") {JSONObject(glesProbe.toString())}
      source("Vulkan_explicit_probe", "explicit_probe_last_result") {JSONObject(gpuProbe.toString())}
      source("owned_mapping_page_probe", "explicit_probe_last_result") {JSONObject(pageProbe.toString())}
      for (name in listOf("meminfo", "vmstat", "stat", "loadavg", "uptime", "pressure/cpu", "pressure/memory", "pressure/io", "diskstats", "net/dev", "net/snmp", "net/netstat", "net/sockstat", "net/sockstat6", "net/softnet_stat", "buddyinfo", "pagetypeinfo", "zoneinfo", "slabinfo", "softirqs", "interrupts", "swaps", "schedstat", "allocinfo", "vmallocinfo", "net/snmp6", "net/protocols", "net/xfrm_stat", "net/rt_cache", "net/stat/arp_cache", "net/stat/ndisc_cache", "net/stat/nf_conntrack", "locks", "sysvipc/msg", "sysvipc/sem", "sysvipc/shm"))
        text("/proc/$name", "system")
      for(name in listOf("file-nr","file-max","inode-state","dentry-state","aio-nr","aio-max-nr","nr_open","pipe-max-size","pipe-user-pages-soft","pipe-user-pages-hard")) text("/proc/sys/fs/$name", "system_filesystem_resources")
      text("/proc/sys/kernel/sched_schedstats", "system_configuration")
      for (name in listOf("online", "present", "possible")) text("/sys/devices/system/cpu/$name", "system")
      // Fixed public sysfs candidates only. No vendor paths, writes or root.
      val cpuEntries = File("/sys/devices/system/cpu").listFiles()
      source("Build_hardware_context", "device_firmware_configuration") {
        JSONObject().put("manufacturer",Build.MANUFACTURER).put("brand",Build.BRAND).put("model",Build.MODEL)
          .put("device",Build.DEVICE).put("product",Build.PRODUCT).put("board",Build.BOARD).put("hardware",Build.HARDWARE)
          .put("supportedAbis",JSONArray(Build.SUPPORTED_ABIS.toList())).put("supported32BitAbis",JSONArray(Build.SUPPORTED_32_BIT_ABIS.toList())).put("supported64BitAbis",JSONArray(Build.SUPPORTED_64_BIT_ABIS.toList()))
          .put("socManufacturer",if(Build.VERSION.SDK_INT>=31) Build.SOC_MANUFACTURER else JSONObject.NULL)
          .put("socModel",if(Build.VERSION.SDK_INT>=31) Build.SOC_MODEL else JSONObject.NULL)
          .put("sku",if(Build.VERSION.SDK_INT>=31) Build.SKU else JSONObject.NULL).put("odmSku",if(Build.VERSION.SDK_INT>=31) Build.ODM_SKU else JSONObject.NULL)
          .put("bootloader",Build.BOOTLOADER).put("buildId",Build.ID).put("buildType",Build.TYPE).put("buildTags",Build.TAGS)
          .put("imageBuildTimestampMs",Build.TIME.toString()).put("incremental",Build.VERSION.INCREMENTAL).put("baseOs",Build.VERSION.BASE_OS)
          .put("securityPatch",Build.VERSION.SECURITY_PATCH).put("sdkInt",Build.VERSION.SDK_INT).put("previewSdkInt",Build.VERSION.PREVIEW_SDK_INT)
          .put("scope","reported hardware/firmware context, not measured performance; native unknown strings retained; no serial number or personal device identifier")
      }
      source("cpu_directory_inventory", "system_configuration") {
        check(cpuEntries!=null) { "CPU directory listing unavailable" };JSONObject().put("names",JSONArray(cpuEntries.map { it.name }.filter { it.matches(Regex("cpu[0-9]+")) })).put("maximumCpuDirectories",256)
      }
      val cpus = cpuEntries?.filter { it.name.matches(Regex("cpu[0-9]+")) }?.sortedBy { it.name } ?: emptyList()
      for (cpu in cpus.take(256)) for (name in listOf("cpufreq/scaling_cur_freq", "cpufreq/cpuinfo_cur_freq", "cpufreq/scaling_min_freq", "cpufreq/scaling_max_freq", "cpufreq/cpuinfo_min_freq", "cpufreq/cpuinfo_max_freq", "cpufreq/scaling_governor", "cpufreq/stats/time_in_state", "topology/core_id", "topology/physical_package_id", "cpu_capacity"))
        text("${cpu.path}/$name", "logical_cpu")
      source("/proc/self/task/*/schedstat", "per_thread") {
        val rows=JSONArray();val begin=now();var complete=true
        val tasks=File("/proc/self/task").listFiles() ?: error("thread enumeration failed")
        for(task in tasks) {
          if(now()-begin>250 || rows.length()>=512 || !foreground || closed) {complete=false;break}
          val tid=task.name.toIntOrNull() ?: continue
          val row=JSONObject().put("threadId",tid).put("queryStartedUptimeMs",now())
          try {
            val before=ThreadCpuStat.parse(File(task,"stat").readText(),tid.toString()).startTicks
            row.put("startTimeTicks",before)
            row.put("sched_getattr",JSONObject(BenchSignalsNative.schedulerAttributes(tid)))
            row.put("text",File(task,"schedstat").readText())
            val after=ThreadCpuStat.parse(File(task,"stat").readText(),tid.toString()).startTicks
            row.put("identityVerified",before==after).put("error",if(before==after) JSONObject.NULL else "thread identity changed")
          } catch(e:Exception) {row.put("identityVerified",false).put("error","${e.javaClass.simpleName}: ${e.message}")}
          row.put("queryFinishedUptimeMs",now());rows.put(row)
        }
        JSONObject().put("threads",rows).put("complete",complete).put("enumerated",tasks.size)
      }
      source("ActivityManager.getHistoricalProcessExitReasons", "package_recent_exit_history") {
        check(Build.VERSION.SDK_INT>=30) { "requires API 30" }
        val exits=(context.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager).getHistoricalProcessExitReasons(context.packageName,0,16)
        JSONObject().put("records",JSONArray().apply { for(exit in exits) put(JSONObject()
          .put("pid",exit.pid).put("processName",exit.processName).put("reason",exit.reason).put("status",exit.status)
          .put("importance",exit.importance).put("timestampMs",exit.timestamp.toString())
          .put("lastSampledPssKiB",exit.pss.toString()).put("lastSampledRssKiB",exit.rss.toString())
          .put("description",exit.description ?: JSONObject.NULL).put("details",ExitDetailSources.read(exit))) })
      }
      source("ActivityManager.getHistoricalProcessStartReasons", "package_startup_history") {StartHistorySources.read(context.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager)}
      source("ActivityManager.getMyMemoryState", "process") {
        val state=ActivityManager.RunningAppProcessInfo();ActivityManager.getMyMemoryState(state)
        JSONObject().put("importance",state.importance).put("lastTrimLevel",state.lastTrimLevel).put("lru",state.lru)
          .put("importanceReasonCode",state.importanceReasonCode).put("nativeParcel",nativeParcel(state))
      }
      source("Process_execution_context", "process_foreground_reservations_and_start_clocks") {
        JSONObject().put("exclusiveCores",JSONArray(Process.getExclusiveCores().toList()))
          .put("startElapsedRealtimeMs",Process.getStartElapsedRealtime().toString())
          .put("startUptimeMs",Process.getStartUptimeMillis().toString())
          .put("startRequestedElapsedRealtimeMs",if(Build.VERSION.SDK_INT>=33) Process.getStartRequestedElapsedRealtime().toString() else JSONObject.NULL)
          .put("startRequestedUptimeMs",if(Build.VERSION.SDK_INT>=33) Process.getStartRequestedUptimeMillis().toString() else JSONObject.NULL)
          .put("note","Exclusive foreground reservations are distinct from affinity; empty means none reported. Native process-start/request clocks, not measured app-ready latency; prewarmed processes may precede requests.")
      }
      source("sysfs_cpu_detail_sources", "logical_cpu_cache_and_idle_state") {SysfsDetailSources.read(cpuDetails=true)}
      for(family in listOf("thermal","cooling","devfreq","power_supply","hwmon","kgsl","block","memory_policy","network","filesystem","mali","dmabuf","mediatek_ged","samsung_gpu","cpu_policy","sgpu","wakeup","suspend","runtime_power","powercap","pmu_catalog","iio_power","qualcomm_core_control","ufs_monitor","slab","backlight","qualcomm_bus_dcvs","kgsl_pagetables","samsung_cpu_limits")) source("sysfs_${family}_sources", "system_or_hardware_device") {SysfsDetailSources.read(family=family)}
      source("native_descriptor_sources", "process_descriptor_range") {JSONObject(BenchSignalsNative.descriptors())}
      source("native_resource_sources", "native_process_thread_and_system") {JSONObject(BenchSignalsNative.resources())}
      source("getrusage(RUSAGE_SELF)", "process") {
        val r = BenchSignalsNative.rusage(); check(r[0] == 0L) { "errno=${r[0]}" }
        val keys = listOf("ru_utime_sec","ru_utime_usec","ru_stime_sec","ru_stime_usec","ru_maxrss","ru_ixrss","ru_idrss","ru_isrss","ru_minflt","ru_majflt","ru_nswap","ru_inblock","ru_oublock","ru_msgsnd","ru_msgrcv","ru_nsignals","ru_nvcsw","ru_nivcsw")
        JSONObject().apply { keys.forEachIndexed { i, key -> put(key, r[i+1].toString()) } }
      }
      source("Debug.binder_and_classes", "process_runtime") {
        JSONObject().put("binderLocalObjects",Debug.getBinderLocalObjectCount().toString())
          .put("binderProxyObjects",Debug.getBinderProxyObjectCount().toString()).put("binderDeathObjects",Debug.getBinderDeathObjectCount().toString())
          .put("binderSentTransactions",Debug.getBinderSentTransactions().toString()).put("binderReceivedTransactions",Debug.getBinderReceivedTransactions().toString())
          .put("loadedClassCount",Debug.getLoadedClassCount().toString())
      }
      source("Debug.getRuntimeStats", "process_art") { JSONObject().apply { Debug.getRuntimeStats().forEach { (key,value) -> put(key,value) } } }
      source("Debug.getMemoryInfo", "process") {
        val m = Debug.MemoryInfo(); Debug.getMemoryInfo(m)
        JSONObject().apply {
          m.memoryStats.forEach { (key,value) -> put(key,value) }
          // Preserve the complete OS record, including category data that has no
          // public SDK getter. Parcel is native/version-specific, not a stable
          // cross-version schema. No hidden API access or inferred layout.
          put("nativeParcel",nativeParcel(m))
          put("totalPss", m.totalPss.toString()); put("totalSwappablePss", m.totalSwappablePss.toString())
          put("totalPrivateDirty", m.totalPrivateDirty.toString()); put("totalSharedDirty", m.totalSharedDirty.toString())
          put("totalPrivateClean", m.totalPrivateClean.toString()); put("totalSharedClean", m.totalSharedClean.toString())
          for ((name, values) in listOf("dalvik" to listOf(m.dalvikPss,m.dalvikPrivateDirty,m.dalvikSharedDirty), "native" to listOf(m.nativePss,m.nativePrivateDirty,m.nativeSharedDirty), "other" to listOf(m.otherPss,m.otherPrivateDirty,m.otherSharedDirty))) {
            put(name+"Pss", values[0].toString()); put(name+"PrivateDirty", values[1].toString()); put(name+"SharedDirty", values[2].toString())
          }
        }
      }
      source("ActivityManager.MemoryInfo", "system") {
        val m = ActivityManager.MemoryInfo(); (context.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager).getMemoryInfo(m)
        JSONObject().put("nativeParcel",nativeParcel(m)).put("availMem",m.availMem.toString()).put("totalMem",m.totalMem.toString()).put("threshold",m.threshold.toString()).put("lowMemory",m.lowMemory).apply { if(Build.VERSION.SDK_INT>=34)put("advertisedMem",m.advertisedMem.toString());if(Build.VERSION.SDK_INT>=37)try {put("freeMem",m.javaClass.getField("freeMem").getLong(m).toString())}catch(e:Exception){put("freeMemError",e.toString())} else put("freeMemUnavailable","requires API 37") }
      }
      source("SystemHealthManager.takeMyUidSnapshot", "uid_batterystats") { HealthSnapshot.read(context.getSystemService(android.os.health.SystemHealthManager::class.java).takeMyUidSnapshot()) }
      source("SystemHealthManager.getGpuHeadroom", "device_gpu_estimate") { GpuHeadroomSource.read(context) }
      source("ComponentCallbacks2", "process_callback_history") {
        synchronized(trimEvents) { JSONObject().put("totalReceived",trimCount.toString()).put("retained",JSONArray().apply { trimEvents.forEach { event -> put(JSONObject().apply {event.forEach {(k,v)->put(k,v)} }) } }) }
      }
      source("PowerManager.getThermalHeadroomThresholds", "device_thermal_policy") {
        check(Build.VERSION.SDK_INT>=35) { "requires API 35" }
        val power=context.getSystemService(Context.POWER_SERVICE) as PowerManager
        JSONObject().apply { power.thermalHeadroomThresholds.forEach { (key,value) -> put(key.toString(),value.toString()) } }
      }
      source("ProfilingManager.system_events", "explicit_system_triggered_profile_experiment") {systemProfileEvents?.snapshot()?:JSONObject().put("error","API 35+ required")}
      source("ProfilingManager.trace_status", "explicit_profile_experiment") {trace.snapshot()}
      val battery = context.getSystemService(Context.BATTERY_SERVICE) as BatteryManager
      for ((name,id) in listOf("currentAverageMicroamps" to BatteryManager.BATTERY_PROPERTY_CURRENT_AVERAGE, "currentNowMicroamps" to BatteryManager.BATTERY_PROPERTY_CURRENT_NOW, "chargeCounterMicroampHours" to BatteryManager.BATTERY_PROPERTY_CHARGE_COUNTER, "capacityPercent" to BatteryManager.BATTERY_PROPERTY_CAPACITY, "status" to BatteryManager.BATTERY_PROPERTY_STATUS)) {
        source("BatteryManager.$name", "battery") { val v=battery.getIntProperty(id); check(v!=Int.MIN_VALUE) { "unsupported property" }; JSONObject().put("raw",v.toString()) }
      }
      source("BatteryManager.energyCounterNanowattHours", "battery") { val v=battery.getLongProperty(BatteryManager.BATTERY_PROPERTY_ENERGY_COUNTER); check(v!=Long.MIN_VALUE) { "unsupported property" }; JSONObject().put("raw",v.toString()) }
      source("BatteryManager.computeChargeTimeRemaining", "battery") { val v=battery.computeChargeTimeRemaining(); check(v>=0) { "estimate unavailable" }; JSONObject().put("milliseconds",v.toString()) }
      source("ACTION_BATTERY_CHANGED", "battery_sticky_report") {
        val b=context.registerReceiver(null,IntentFilter(Intent.ACTION_BATTERY_CHANGED)) ?: error("no sticky report")
        JSONObject().apply {
          for (key in listOf("level","scale","status","health","plugged","temperature","voltage","cycle_count","charging_status","capacity_level"))
            if(b.hasExtra(key)) put(key,b.getIntExtra(key,Int.MIN_VALUE).toString())
          if(b.hasExtra("present")) put("present",b.getBooleanExtra("present",false))
          if(b.hasExtra(BatteryManager.EXTRA_BATTERY_LOW))put("battery_low",b.getBooleanExtra(BatteryManager.EXTRA_BATTERY_LOW,false))
          if(b.hasExtra(BatteryManager.EXTRA_TECHNOLOGY))put("technology",b.getStringExtra(BatteryManager.EXTRA_TECHNOLOGY)?:JSONObject.NULL)
          put("rawExtras",BatteryIntentSources.read(b))
        }
      }
      source("PowerManager", "system") { val power=context.getSystemService(Context.POWER_SERVICE) as PowerManager; JSONObject().put("isPowerSaveMode",power.isPowerSaveMode).put("isDeviceIdleMode",power.isDeviceIdleMode).put("isInteractive",power.isInteractive) }
      source("StatFs(app_files)", "filesystem") { val s=StatFs(context.filesDir.path); JSONObject().put("blockSize",s.blockSizeLong.toString()).put("blockCount",s.blockCountLong.toString()).put("freeBlocks",s.freeBlocksLong.toString()).put("availableBlocks",s.availableBlocksLong.toString()) }
      source("display_sources", "display_configuration_and_timing") {DisplaySources.read(context)}
      source("power_policy_sources", "system_policy_and_own_app_context") {PowerPolicySources.read(context)}
      source("network_link_sources", "active_network_and_wifi_link") {NetworkSources.read(context)}
      source("storage_accounting_sources", "app_uid_and_volume") {storageSources.read()}
      source("TrafficStats", "uid_and_system_since_boot") {
        JSONObject().apply {
          for ((key,v) in listOf("uidRxBytes" to TrafficStats.getUidRxBytes(Process.myUid()),"uidTxBytes" to TrafficStats.getUidTxBytes(Process.myUid()),"uidRxPackets" to TrafficStats.getUidRxPackets(Process.myUid()),"uidTxPackets" to TrafficStats.getUidTxPackets(Process.myUid()),"totalRxBytes" to TrafficStats.getTotalRxBytes(),"totalTxBytes" to TrafficStats.getTotalTxBytes(),"totalRxPackets" to TrafficStats.getTotalRxPackets(),"totalTxPackets" to TrafficStats.getTotalTxPackets(),"mobileRxBytes" to TrafficStats.getMobileRxBytes(),"mobileTxBytes" to TrafficStats.getMobileTxBytes(),"mobileRxPackets" to TrafficStats.getMobileRxPackets(),"mobileTxPackets" to TrafficStats.getMobileTxPackets()))
            put(key,if(v==TrafficStats.UNSUPPORTED.toLong()) JSONObject.NULL else v.toString())
        }
      }
      source("sysconf_and_clocks", "environment") { JSONObject().put("pageSize",Os.sysconf(OsConstants._SC_PAGESIZE).toString()).put("clockTicksPerSecond",Os.sysconf(OsConstants._SC_CLK_TCK).toString()).put("configuredProcessors",Os.sysconf(OsConstants._SC_NPROCESSORS_CONF).toString()).put("onlineProcessors",Os.sysconf(OsConstants._SC_NPROCESSORS_ONLN).toString()).put("elapsedRealtimeMs",SystemClock.elapsedRealtime().toString()).put("uptimeMs",SystemClock.uptimeMillis().toString()) }
      check(foreground && !closed) { "Source sampling interrupted" }
      val row=JSONObject().put("captureSchema",1).put("platform","android").put("appVersion",BuildConfig.VERSION_NAME)
        .put("processId",Process.myPid()).put("sequence",++sequence).put("sampledAtMs",System.currentTimeMillis())
        .put("clockSource","SystemClock.elapsedRealtimeNanos").put("apiLevel",Build.VERSION.SDK_INT)
        .put("osVersion",Build.VERSION.RELEASE).put("fingerprint",Build.FINGERPRINT).put("sources",sources)
      val capture=BenchSignalsNative.append(File(context.getExternalFilesDir(null) ?: context.filesDir,"source-captures").path,row.toString().toByteArray(Charsets.UTF_8))
      val summary=Arguments.createMap().apply { putString("platform","android"); putDouble("sequence",sequence.toDouble());putInt("sources",sources.length());putInt("unavailable",(0 until sources.length()).count { !sources.getJSONObject(it).isNull("error") });putString("traceState",trace.snapshot().optString("state")+" · OS profiles: "+(systemProfileEvents?.snapshot()?.optString("state")?:"API 35+ required"));putString("state",capture[0]);putString("path",capture[1]) }
      Log.i("WfloatSignals",JSONObject().apply { summary.toHashMap().forEach { (key,value) -> put(key,value) } }.toString());promise.resolve(summary)
    } catch(e:Exception) { promise.reject("SIGNALS_FAILED",e.message,e) }
  }
  override fun onHostResume() { foreground=true;thermalEvents.start();powerEvents.start();temperatureSensors.start() }
  override fun onHostPause() { foreground=false;trace.cancel();frameProbe.stop();thermalEvents.stop();powerEvents.stop();temperatureSensors.stop() }
  override fun onHostDestroy() { foreground=false;trace.cancel();frameProbe.stop();thermalEvents.stop();powerEvents.stop();temperatureSensors.stop() }
  override fun invalidate() { closed=true;trace.close();systemProfileEvents?.close();frameProbe.stop();thermalEvents.stop();powerEvents.stop();temperatureSensors.stop();context.unregisterComponentCallbacks(this); context.removeLifecycleEventListener(this);super.invalidate() }
}
