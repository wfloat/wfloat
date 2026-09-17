package com.wfloat.bench
import android.content.Context
import android.hardware.display.DisplayManager
import android.os.Build
import android.view.Display
import android.provider.Settings
import org.json.JSONArray
import org.json.JSONObject
internal object DisplaySources {
  fun read(context:Context):JSONObject {
    fun mode(m:Display.Mode)=JSONObject().put("modeId",m.modeId).put("physicalWidth",m.physicalWidth).put("physicalHeight",m.physicalHeight).put("refreshRateHz",m.refreshRate.toString()).apply {
      if(Build.VERSION.SDK_INT>=31)put("alternativeRefreshRatesHz",JSONArray(m.alternativeRefreshRates.map {it.toString()}))
      if(Build.VERSION.SDK_INT>=34)put("supportedHdrTypes",JSONArray(m.supportedHdrTypes.toList()))
    }
    val displays=context.getSystemService(DisplayManager::class.java).displays
    val rows=JSONArray()
    for(d in displays.take(16)){
      val row=JSONObject().put("displayId",d.displayId).put("name",d.name).put("valid",d.isValid).put("state",d.state).put("flags",d.flags).put("rotation",d.rotation)
      try {
        row.put("currentMode",mode(d.mode)).put("reportedRefreshRateHz",d.refreshRate.toString()).put("appVsyncOffsetNanos",d.appVsyncOffsetNanos.toString()).put("presentationDeadlineNanos",d.presentationDeadlineNanos.toString())
        row.put("supportedModes",JSONArray(d.supportedModes.take(128).map {mode(it)})).put("reportedModeCount",d.supportedModes.size)
        val hdr=d.hdrCapabilities;row.put("hdr",JSONObject().put("types",JSONArray(hdr.supportedHdrTypes.toList())).put("desiredMaximumLuminance",hdr.desiredMaxLuminance.toString()).put("desiredMaximumAverageLuminance",hdr.desiredMaxAverageLuminance.toString()).put("desiredMinimumLuminance",hdr.desiredMinLuminance.toString()))
        if(Build.VERSION.SDK_INT>=26)row.put("wideColorGamut",d.isWideColorGamut)
        if(Build.VERSION.SDK_INT>=34){row.put("hdrSdrRatioAvailable",d.isHdrSdrRatioAvailable);if(d.isHdrSdrRatioAvailable)row.put("hdrSdrRatio",d.hdrSdrRatio.toString())}
        if(Build.VERSION.SDK_INT>=36)row.put("adaptiveRefreshRateSupported",d.hasArrSupport())
        row.put("error",JSONObject.NULL)
      }catch(e:Exception){row.put("error",e.toString())};rows.put(row)
    }
    val settings=JSONObject().put("scope","OS stored brightness/mode/timeout settings, not measured panel luminance or an app window override")
    for(key in listOf(Settings.System.SCREEN_BRIGHTNESS,Settings.System.SCREEN_BRIGHTNESS_MODE,Settings.System.SCREEN_OFF_TIMEOUT))try {settings.put(key,Settings.System.getInt(context.contentResolver,key))}catch(e:Exception){settings.put(key+"Error",e.toString())}
    return JSONObject().put("brightnessSettings",settings).put("displays",rows).put("reportedDisplayCount",displays.size).put("scope","display configuration and scheduling; reported refresh is not measured presentation; HDR limits are capabilities, not measured luminance")
  }
}
