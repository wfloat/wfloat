package com.wfloat.bench

import android.content.Context
import android.os.Build
import android.os.ProfilingManager
import android.os.ProfilingResult
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.concurrent.Executors
import java.util.function.Consumer

/** Explicit OS-triggered/running-trace experiments, not enabled by sampling. */
internal class SystemProfileEvents(private val context:Context) {
  private val executor=Executors.newSingleThreadExecutor()
  private var manager:ProfilingManager?=null
  private var callback:Consumer<ProfilingResult>?=null
  private val results=ArrayDeque<JSONObject>()
  private var state="not_requested"
  private var error:String?=null
  private var enabledHere=false
  @Volatile private var closed=false
  init {try {connect()}catch(e:Exception){state="listener_unavailable";error=e.toString()}}
  @Synchronized fun snapshot():JSONObject=JSONObject().put("state",state).put("error",error?:JSONObject.NULL).put("triggersEnabledByThisInstance",enabledHere).put("results",JSONArray(results.map {JSONObject(it.toString())})).put("scope","Explicit OS-trigger registration/running-system-trace request; profiling has overhead and OS rate limits. Raw artifacts retained. Passive result listener starts with the module; no automatic trigger registration from periodic sampling.")
  @Synchronized private fun connect():ProfilingManager {
    check(!closed && Build.VERSION.SDK_INT>=35){"Profiling results require API 35+"}
    manager?.let{return it}
    val service=context.getSystemService(ProfilingManager::class.java)?:error("Profiling service unavailable")
    val consumer=Consumer<ProfilingResult> {result ->
      // The separate manual-profile collector already exports these artifacts.
      if(result.tag!="wfloat-os-sources") synchronized(this) {
        if(!closed){
          state=if(result.errorCode==0) "system_profile_delivered" else "system_profile_failed"
          val row=JSONObject().put("receivedAtMs",System.currentTimeMillis()).put("errorCode",result.errorCode).put("error",result.errorMessage?:JSONObject.NULL).put("tag",result.tag?:JSONObject.NULL).put("systemPath",result.resultFilePath?:JSONObject.NULL)
          try {row.put("triggerType",result.javaClass.getMethod("getTriggerType").invoke(result))}catch(e:Exception){row.put("triggerTypeError",e.toString())}
          if(result.errorCode==0 && result.resultFilePath!=null)try {
            val input=File(result.resultFilePath!!);check(input.length()<=16*1024*1024){"Profile exceeds 16 MiB export bound; original retained"}
            val dir=File(context.getExternalFilesDir(null)?:context.filesDir,"profile-exports");dir.mkdirs()
            check((dir.listFiles()?.sumOf {it.length()}?:0)+input.length()<=32*1024*1024){"Export directory full; original retained"}
            val output=File(dir,input.name);check(!output.exists()){"Artifact already exported; original retained"}
            input.copyTo(output,false);row.put("path",output.path).put("bytes",output.length().toString())
          }catch(e:Exception){row.put("exportError",e.toString())}
          if(results.size>=32)results.removeFirst();results.addLast(row)
        }
      }
    }
    service.registerForAllProfilingResults(executor,consumer);manager=service;callback=consumer;return service
  }
  @Synchronized fun setTriggers(enable:Boolean) {
    try {
      val service=connect()
      // Public SDK extension API; reflect so API 35/36.0 report absence cleanly.
      service.javaClass.getMethod(if(enable) "addAllProfilingTriggers" else "clearProfilingTriggers").invoke(service)
      enabledHere=enable;state=if(enable) "system_triggers_registered" else "system_triggers_cleared";error=null
    }catch(e:Exception){state="request_failed";error=e.toString();throw e}
  }
  @Synchronized fun requestRunningTrace() {
    try {val service=connect();service.javaClass.getMethod("requestRunningSystemTrace",String::class.java).invoke(service,"wfloat-running-sources");state="running_trace_requested";error=null}
    catch(e:Exception){state="request_failed";error=e.toString();throw e}
  }
  @Synchronized fun close() {
    if(enabledHere)try {manager?.javaClass?.getMethod("clearProfilingTriggers")?.invoke(manager)}catch(_:Exception){}
    callback?.let {try {manager?.unregisterForAllProfilingResults(it)}catch(_:Exception){}}
    closed=true;executor.shutdown()
  }
}
