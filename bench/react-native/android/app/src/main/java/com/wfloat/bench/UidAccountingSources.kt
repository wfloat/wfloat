package com.wfloat.bench

import android.os.Process
import android.os.SystemClock
import android.util.Base64
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.nio.ByteBuffer
import java.nio.ByteOrder

/** Kernel UID accounting has different lifetime/scope from the current process. */
internal object UidAccountingSources {
  fun read():JSONObject {
    val uid=Process.myUid();val rows=JSONArray()
    for(path in listOf("/proc/uid_io/stats","/proc/uid_cputime/show_uid_stat","/proc/uid_time_in_state","/proc/uid_concurrent_active_time","/proc/uid_concurrent_policy_time","/proc/uid/$uid/time_in_state")) {
      val began=SystemClock.elapsedRealtimeNanos();val row=JSONObject().put("path",path).put("startedUptimeNanos",began.toString())
      try {
        val limit=262144;val raw=File(path).inputStream().use {input->val b=ByteArray(limit+1);var n=0;while(n<b.size){val got=input.read(b,n,b.size-n);if(got<0)break;n+=got};b.copyOf(n)}
        val kept=raw.copyOf(minOf(raw.size,limit));val truncated=raw.size>limit
        row.put("readBytes",raw.size).put("truncated",truncated)
        if(path=="/proc/uid/$uid/time_in_state") {
          row.put("rawBase64",Base64.encodeToString(kept,Base64.NO_WRAP)).put("nativeByteOrder",ByteOrder.nativeOrder().toString())
          val words=JSONArray();val buffer=ByteBuffer.wrap(kept).order(ByteOrder.nativeOrder())
          while(buffer.remaining()>=8)words.put(java.lang.Long.toUnsignedString(buffer.long))
          row.put("nativeUint64Words",words).put("trailingBytes",buffer.remaining()).put("semantics","Native clock-tick frequency residency array; frequency ordering comes from the kernel's UID time-in-state header; no guessed ordering or conversion")
        } else {
          val own=JSONArray();val headers=JSONArray();val lines=kept.toString(Charsets.UTF_8).split('\n')
          for((index,line) in lines.withIndex()) {
            if(truncated && index==lines.lastIndex)continue
            val first=line.trimStart().substringBefore(' ').substringBefore('\t').removeSuffix(":")
            if(first==uid.toString())own.put(line)
            else if(first in listOf("uid","cpus","policy0") || line.startsWith("policy"))headers.put(line)
          }
          row.put("ownUidRows",own).put("headers",headers).put("ownUidPresent",own.length()>0)
        }
        row.put("error",JSONObject.NULL)
      }catch(e:Exception){row.put("error","${e.javaClass.simpleName}: ${e.message}")}
      row.put("finishedUptimeNanos",SystemClock.elapsedRealtimeNanos().toString());rows.put(row)
    }
    return JSONObject().put("uid",uid).put("queries",rows).put("scope","Kernel UID accounting including exited processes; only own UID rows retained. IO splits kernel foreground/background state; reads refresh cumulative accounting, do not reset it. Missing/denied rows are not zero usage.")
  }
}
