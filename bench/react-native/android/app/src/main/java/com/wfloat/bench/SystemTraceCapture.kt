package com.wfloat.bench

import android.content.Context
import android.os.*
import androidx.annotation.RequiresApi
import org.json.JSONObject
import java.io.File
import java.util.concurrent.Executors

// Optional active experiment, never part of periodic sampling. Keep platform
// cancellation; do not disable the system's profiling rate limits.
internal class SystemTraceCapture(private val context:Context) {
  private val executor=Executors.newSingleThreadExecutor()
  private val handler=Handler(Looper.getMainLooper())
  @Volatile private var closed=false
  private val callbackExecutor=java.util.concurrent.Executor { task ->
    if(!closed) try {executor.execute(task)} catch(_:java.util.concurrent.RejectedExecutionException) {}
  }
  private var cancellation:CancellationSignal?=null
  private var row=JSONObject().put("state","not_requested")
  @Synchronized fun snapshot():JSONObject=JSONObject(row.toString())
  @Synchronized fun start(kind:Int=4) {
    check(!closed) { "Profiler closed" }
    check(kind in 1..4) { "Unknown profiling type" }
    check(Build.VERSION.SDK_INT>=35) { "System trace requires API 35" }
    check(cancellation==null) { "A trace request is already pending" }
    val signal=CancellationSignal();cancellation=signal
    row=JSONObject().put("profilingType",kind).put("state","requested").put("requestedAtMs",System.currentTimeMillis())
    // Bundle keys/types match AndroidX HeapProfileRequestBuilder in
    // frameworks/support/core/core/src/main/java/androidx/core/os/Profiling.kt.
    // Coarser allocation sampling reduces producer pressure. Delivery still
    // requires an independent trace-health check; it does not prove completeness.
    val params=if(kind==2) Bundle().apply {putInt("KEY_SIZE_KB",8192);putInt("KEY_DURATION_MS",10000);putLong("KEY_SAMPLING_INTERVAL_BYTES",65536L);putBoolean("KEY_TRACK_JAVA_ALLOCATIONS",false)} else null
    row.put("requestedParameters",if(params==null) JSONObject.NULL else JSONObject().put("bufferSizeKb",8192).put("durationMs",10000).put("samplingIntervalBytes",65536).put("trackJavaAllocations",false))
    try { Api35.request(context,kind,params,signal,callbackExecutor) { code,message,path ->
      synchronized(this) {
        if(closed) return@synchronized
        cancellation=null
        row.put("errorCode",code).put("errorName",listOf("none","rate_limit_system","rate_limit_process","profiling_in_progress","executing","post_processing","no_disk_space","invalid_request","unknown").getOrElse(code) { "unknown_code" }).put("error",message ?: JSONObject.NULL).put("receivedAtMs",System.currentTimeMillis())
        row.put("state",if(code==0) "delivered" else "failed")
        if(path!=null) row.put("systemPath",path)
        if(code==0 && path!=null) {
          try {
            val input=File(path);check(input.length()<=16*1024*1024) { "Trace exceeds 16 MiB export bound; original retained" }
            val directory=File(context.getExternalFilesDir(null) ?: context.filesDir,"profile-exports");directory.mkdirs()
            check((directory.listFiles()?.sumOf { it.length() } ?: 0)+input.length()<=32*1024*1024) { "Trace export directory full; original retained" }
            val output=File(directory,input.name);check(!output.exists()) { "Export already exists; refusing overwrite" }
            input.copyTo(output,false);row.put("path",output.path).put("bytes",output.length().toString())
          } catch(e:Exception) {row.put("exportError",e.message)}
        }
      }
    } } catch(e:Exception) {cancellation=null;row.put("state","failed").put("error",e.message);throw e}
    handler.postDelayed({signal.cancel()},30000)
  }
  @Synchronized fun cancel() { cancellation?.cancel() }
  fun close() {closed=true;cancel();handler.removeCallbacksAndMessages(null);executor.shutdown()}
  @RequiresApi(35)
  private object Api35 {
    fun request(context:Context,kind:Int,params:Bundle?,signal:CancellationSignal,executor:java.util.concurrent.Executor,callback:(Int,String?,String?)->Unit) {
      val manager=context.getSystemService(ProfilingManager::class.java) ?: error("Profiling service missing")
      manager.requestProfiling(kind,params,"wfloat-os-sources",signal,executor) {result->callback(result.errorCode,result.errorMessage,result.resultFilePath)}
    }
  }
}
