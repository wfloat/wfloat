package com.wfloat.bench

import android.app.ActivityManager
import android.content.Context
import android.os.Build
import android.os.Debug
import android.os.PowerManager
import android.os.SystemClock
import org.json.JSONObject

/** Public policy/context getters; no wake locks, policy changes or battery discharge. */
internal object PowerPolicySources {
  fun read(context:Context):JSONObject {
    val rows=JSONObject()
    fun query(name:String,api:Int,read:()->Any?) {
      val start=SystemClock.elapsedRealtimeNanos()
      val row=JSONObject().put("minimumApi",api).put("startedUptimeNanos",start.toString())
      if(Build.VERSION.SDK_INT<api)row.put("error","requires API $api").put("value",JSONObject.NULL)
      else try {row.put("value",read()?:JSONObject.NULL).put("error",JSONObject.NULL)}catch(e:Exception){row.put("value",JSONObject.NULL).put("error",e.toString())}
      rows.put(name,row.put("finishedUptimeNanos",SystemClock.elapsedRealtimeNanos().toString()))
    }
    val power=context.getSystemService(PowerManager::class.java)
    query("batteryDischargePrediction",31){power.batteryDischargePrediction?.let {JSONObject().put("seconds",it.seconds.toString()).put("nanoAdjustment",it.nano)}}
    query("isBatteryDischargePredictionPersonalized",31){power.isBatteryDischargePredictionPersonalized}
    query("isDeviceLightIdleMode",33){power.isDeviceLightIdleMode}
    query("isLowPowerStandbyEnabled",33){power.isLowPowerStandbyEnabled}
    query("isExemptFromLowPowerStandby",34){power.isExemptFromLowPowerStandby}
    query("isIgnoringBatteryOptimizationsOwnPackage",23){power.isIgnoringBatteryOptimizations(context.packageName)}
    query("isSustainedPerformanceModeSupported",24){power.isSustainedPerformanceModeSupported}
    query("locationPowerSaveMode",28){power.locationPowerSaveMode}
    for((name,reason) in listOf("VOICE_INTERACTION" to PowerManager.LOW_POWER_STANDBY_ALLOWED_REASON_VOICE_INTERACTION,"TEMP_POWER_SAVE_ALLOWLIST" to PowerManager.LOW_POWER_STANDBY_ALLOWED_REASON_TEMP_POWER_SAVE_ALLOWLIST,"ONGOING_CALL" to PowerManager.LOW_POWER_STANDBY_ALLOWED_REASON_ONGOING_CALL))
      query("isAllowedInLowPowerStandby.$name",34){power.isAllowedInLowPowerStandby(reason)}
    query("isAllowedInLowPowerStandby.WAKE_ON_LAN",34){power.isAllowedInLowPowerStandby(PowerManager.FEATURE_WAKE_ON_LAN_IN_LOW_POWER_STANDBY)}
    query("appStandbyBucket",28){context.getSystemService(android.app.usage.UsageStatsManager::class.java).appStandbyBucket}
    val activity=context.getSystemService(ActivityManager::class.java)
    query("memoryClassMiB",1){activity.memoryClass}
    query("largeMemoryClassMiB",11){activity.largeMemoryClass}
    query("isLowRamDevice",19){activity.isLowRamDevice}
    query("isBackgroundRestricted",28){activity.isBackgroundRestricted}
    query("isLowMemoryKillReportSupported",30){ActivityManager.isLowMemoryKillReportSupported()}
    query("isDebuggerConnected",1){Debug.isDebuggerConnected()}
    return JSONObject().put("observations",rows).put("semantics","OS policy/capability context, not measured throttling. Discharge prediction may be null while charging or unavailable; personalization is a separate property. Memory classes are configured Java budgets.")
  }
}
