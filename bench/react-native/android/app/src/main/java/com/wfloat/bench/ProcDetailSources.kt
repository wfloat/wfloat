package com.wfloat.bench

import android.os.SystemClock
import android.system.Os
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

internal object ProcDetailSources {
  fun threadRecords():JSONObject {
    val began=SystemClock.elapsedRealtimeNanos();val tasks=File("/proc/self/task").listFiles() ?: error("thread enumeration unavailable")
    val rows=JSONArray();var bytes=0;var limited=false
    for(task in tasks.sortedBy {it.name.toIntOrNull() ?: Int.MAX_VALUE}) {
      if(rows.length()>=512 || bytes>=1048576 || SystemClock.elapsedRealtimeNanos()-began>250000000){limited=true;break}
      val tid=task.name.toIntOrNull() ?: continue;val row=JSONObject().put("threadId",tid).put("startedUptimeNanos",SystemClock.elapsedRealtimeNanos().toString());val records=JSONArray()
      try {
        val before=ThreadCpuStat.parse(File(task,"stat").readText(),tid.toString()).startTicks;row.put("startTimeTicks",before)
        for(name in listOf("stat","status","sched","io","time_in_state","cgroup","wchan","syscall","stack","latency","timerslack_ns")) {
          if(bytes>=1048576 || SystemClock.elapsedRealtimeNanos()-began>250000000){limited=true;break}
          val v=JSONObject().put("name",name).put("startedUptimeNanos",SystemClock.elapsedRealtimeNanos().toString())
          try {val limit=minOf(32768,1048576-bytes);val raw=File(task,name).inputStream().use {input->val b=ByteArray(limit+1);var n=0;while(n<b.size){val got=input.read(b,n,b.size-n);if(got<0)break;n+=got};b.copyOf(n)};bytes+=raw.size;v.put("text",raw.copyOf(minOf(raw.size,limit)).toString(Charsets.UTF_8)).put("truncated",raw.size>limit).put("error",JSONObject.NULL)}
          catch(e:Exception){v.put("text",JSONObject.NULL).put("error","${e.javaClass.simpleName}: ${e.message}")}
          v.put("finishedUptimeNanos",SystemClock.elapsedRealtimeNanos().toString());records.put(v)
        }
        val after=ThreadCpuStat.parse(File(task,"stat").readText(),tid.toString()).startTicks;row.put("identityVerified",before==after).put("error",if(before==after)JSONObject.NULL else "thread identity changed")
      }catch(e:Exception){row.put("identityVerified",false).put("error","${e.javaClass.simpleName}: ${e.message}")}
      row.put("records",records).put("finishedUptimeNanos",SystemClock.elapsedRealtimeNanos().toString());rows.put(row)
    }
    return JSONObject().put("threads",rows).put("enumerated",tasks.size).put("readBytes",bytes).put("boundedScanLimitReached",limited)
  }
  fun descriptors():JSONObject {
    val began=SystemClock.elapsedRealtimeNanos();val files=File("/proc/self/fd").listFiles() ?: error("fd enumeration unavailable")
    val rows=JSONArray();var bytes=0;var complete=true
    for(file in files.sortedBy {it.name.toIntOrNull() ?: Int.MAX_VALUE}) {
      if(rows.length()>=512 || bytes>=524288 || SystemClock.elapsedRealtimeNanos()-began>100000000) {complete=false;break}
      val fd=file.name.toIntOrNull() ?: continue
      val row=JSONObject().put("fd",fd).put("queryStartedUptimeNanos",SystemClock.elapsedRealtimeNanos().toString())
      try {
        val target=Os.readlink(file.path);val before=Os.stat(file.path)
        val raw=File("/proc/self/fdinfo/$fd").inputStream().use {input->val buffer=ByteArray(minOf(16385,524289-bytes));var n=0;while(n<buffer.size){val got=input.read(buffer,n,buffer.size-n);if(got<0)break;n+=got};buffer.copyOf(n)}
        bytes+=raw.size;val kept=raw.copyOf(minOf(16384,raw.size));val after=Os.stat(file.path)
        row.put("target",target).put("fdinfo",kept.toString(Charsets.UTF_8)).put("truncated",raw.size>kept.size)
          .put("device",before.st_dev.toString()).put("inode",before.st_ino.toString()).put("mode",before.st_mode.toString()).put("size",before.st_size.toString())
          .put("observedMetadataStable",before.st_dev==after.st_dev && before.st_ino==after.st_ino && target==Os.readlink(file.path)).put("error",JSONObject.NULL)
      }catch(e:Exception){row.put("error","${e.javaClass.simpleName}: ${e.message}")}
      row.put("queryFinishedUptimeNanos",SystemClock.elapsedRealtimeNanos().toString());rows.put(row)
    }
    return JSONObject().put("descriptors",rows).put("enumerated",files.size).put("complete",complete).put("readBytes",bytes)
  }
}
