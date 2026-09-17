package com.wfloat.bench

import android.os.health.*
import org.json.JSONObject

// Public HealthStats keys retain Android's own names and UID/time-base semantics.
// This is a BatteryStats snapshot, not a fresh energy sensor or app-only profiler.
internal object HealthSnapshot {
  private val names by lazy {
    listOf(UidHealthStats::class.java,PidHealthStats::class.java,ProcessHealthStats::class.java,PackageHealthStats::class.java,ServiceHealthStats::class.java)
      .associate { cls -> cls.simpleName to cls.fields.filter { it.type == Int::class.javaPrimitiveType }.associate { it.getInt(null) to it.name } }
  }
  fun read(stats: HealthStats): JSONObject {
    var nodes=0
    fun scan(s:HealthStats,depth:Int):JSONObject {
      check(depth<12 && ++nodes<=4096) { "HealthStats nesting/entry limit" }
      val n=names[s.dataType] ?: emptyMap()
      fun key(k:Int)="${n[k] ?: "UNKNOWN"}[$k]"
      fun timer(t:TimerStat)=JSONObject().put("count",t.count.toString()).put("timeMs",t.time.toString())
      return JSONObject().put("dataType",s.dataType).apply {
        put("measurements",JSONObject().apply { for(i in 0 until s.measurementKeyCount) {val k=s.getMeasurementKeyAt(i);put(key(k),s.getMeasurement(k).toString())} })
        put("timers",JSONObject().apply { for(i in 0 until s.timerKeyCount) {val k=s.getTimerKeyAt(i);put(key(k),timer(s.getTimer(k)))} })
        put("measurementMaps",JSONObject().apply { for(i in 0 until s.measurementsKeyCount) {val k=s.getMeasurementsKeyAt(i);put(key(k),JSONObject().apply {s.getMeasurements(k).forEach { (name,v)->put(name,v.toString()) }})} })
        put("timerMaps",JSONObject().apply {for(i in 0 until s.timersKeyCount) {val k=s.getTimersKeyAt(i);put(key(k),JSONObject().apply {s.getTimers(k).forEach { (name,v)->put(name,timer(v)) }})} })
        put("stats",JSONObject().apply {for(i in 0 until s.statsKeyCount) {val k=s.getStatsKeyAt(i);put(key(k),JSONObject().apply {s.getStats(k).forEach { (name,v)->put(name,scan(v,depth+1)) }})} })
      }
    }
    return scan(stats,0)
  }
}
