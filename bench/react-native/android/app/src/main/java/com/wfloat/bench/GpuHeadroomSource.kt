package com.wfloat.bench

import android.content.Context
import android.os.Build
import android.os.GpuHeadroomParams
import android.os.SystemClock
import android.os.health.SystemHealthManager
import androidx.annotation.RequiresApi
import org.json.JSONObject

internal object GpuHeadroomSource {
  fun read(context:Context):JSONObject {
    check(Build.VERSION.SDK_INT>=36) { "requires API 36" }
    return Api36.read(context)
  }
  @RequiresApi(36)
  private object Api36 {
    private var nextQuery=0L
    @Synchronized fun read(context:Context):JSONObject {
      val health=context.getSystemService(SystemHealthManager::class.java) ?: error("service missing")
      val now=SystemClock.elapsedRealtime()
      if(now<nextQuery) return JSONObject().put("availability","cadence_wait").put("nextQueryUptimeMs",nextQuery.toString())
      val interval=health.gpuHeadroomMinIntervalMillis
      check(interval in 0..Int.MAX_VALUE.toLong()) { "invalid minimum interval" }
      nextQuery=now+maxOf(10000L,interval)
      val range=health.gpuHeadroomCalculationWindowRange
      check(range.first>0 && range.second>=range.first) { "invalid calculation range" }
      val window=2000.coerceIn(range.first,range.second)
      val value=health.getGpuHeadroom(GpuHeadroomParams.Builder().setCalculationType(GpuHeadroomParams.GPU_HEADROOM_CALCULATION_TYPE_AVERAGE).setCalculationWindowMillis(window).build())
      return JSONObject().put("raw",value.toString()).put("availability",if(value.isNaN()) "unavailable" else if(value.isFinite() && value in 0f..100f) "available" else "invalid_value")
        .put("minimumIntervalMs",interval.toString()).put("calculationType","average").put("calculationWindowMs",window).put("sourceTimestampKnown",false)
    }
  }
}
