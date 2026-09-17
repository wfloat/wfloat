package com.wfloat.bench

import android.app.ActivityManager
import android.os.Build
import org.json.JSONArray
import org.json.JSONObject

/** OS-owned start history, not app or SDK instrumentation. */
internal object StartHistorySources {
  fun read(manager:ActivityManager):JSONObject {
    check(Build.VERSION.SDK_INT>=35) {"requires API 35"}
    val rows=JSONArray()
    for(start in manager.getHistoricalProcessStartReasons(16).take(16)) {
      val timestamps=JSONObject()
      for((key,value) in start.startupTimestamps)timestamps.put(key.toString(),value.toString())
      rows.put(JSONObject().put("pid",start.pid).put("processName",start.processName)
        .put("realUid",start.realUid).put("packageUid",start.packageUid).put("definingUid",start.definingUid)
        .put("startupState",start.startupState).put("reason",start.reason).put("startType",start.startType)
        .put("launchMode",start.launchMode).put("wasForceStopped",start.wasForceStopped())
        .put("startComponent",if(Build.VERSION.SDK_INT>=36) start.startComponent else JSONObject.NULL)
        .put("startupTimestampsMonotonicNanos",timestamps))
    }
    return JSONObject().put("records",rows).put("recordLimit",16)
      .put("timestampCodes",JSONObject().put("0","launch").put("1","fork").put("2","application_onCreate").put("3","bind_application").put("4","first_frame").put("5","fully_drawn").put("6","initial_renderthread_frame").put("7","surfaceflinger_composition_complete"))
      .put("scope","OS-provided own-app start history, complete returned timestamp maps; startupState controls which fields are final. Missing timestamps remain missing; fully_drawn is app-reported if supplied. No startup instrumentation added and no duration derived.")
  }
}
