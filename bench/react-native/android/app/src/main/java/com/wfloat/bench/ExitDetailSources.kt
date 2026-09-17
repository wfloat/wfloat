package com.wfloat.bench

import android.app.ApplicationExitInfo
import android.os.Build
import android.util.Base64
import org.json.JSONObject

internal object ExitDetailSources {
  private val traces=linkedMapOf<String,JSONObject>()
  @Synchronized fun read(exit:ApplicationExitInfo):JSONObject {
    val row=JSONObject()
    if(Build.VERSION.SDK_INT>=37)try {
      val info=exit.javaClass.getMethod("getAnrInfo").invoke(exit)
      row.put("anrInfo",if(info==null)JSONObject.NULL else JSONObject().apply {
        for(name in listOf("getAnrId","getAnrType","getTimeoutMillis","isUserPerceptible"))try {
          val value=info.javaClass.getMethod(name).invoke(info);put(name,if(value is Long)value.toString() else value?:JSONObject.NULL)
        }catch(e:Exception){put(name+"Error",e.toString())}
      })
    }catch(e:Exception){row.put("anrInfoError",e.toString())} else row.put("anrInfoUnavailable","requires API 37")
    val key="${exit.pid}:${exit.timestamp}:${exit.reason}"
    val trace=traces[key]?:run {
      val value=JSONObject().put("readAtMs",System.currentTimeMillis()).put("scope","OS-retained own-package exit trace; ANR text or native-crash protobuf, native bytes with explicit 64 KiB prefix bound. Not an additional live sample.")
      try {
        val stream=exit.traceInputStream
        if(stream==null)value.put("present",false) else stream.use {
          val buffer=ByteArray(65537);var count=0
          while(count<buffer.size){val n=it.read(buffer,count,buffer.size-count);if(n<0)break;if(n==0)break;count+=n}
          value.put("present",true).put("bytesRead",count).put("truncated",count>65536).put("rawBase64",Base64.encodeToString(buffer,0,minOf(count,65536),Base64.NO_WRAP))
        }
      }catch(e:Exception){value.put("error",e.toString())}
      if(value.optBoolean("present") && !value.has("error")){if(traces.size>=32)traces.remove(traces.keys.first());traces[key]=value};value
    }
    return row.put("trace",trace)
  }
}
