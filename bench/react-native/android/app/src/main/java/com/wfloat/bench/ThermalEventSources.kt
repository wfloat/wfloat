package com.wfloat.bench
import android.content.Context
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.os.SystemClock
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.Executor

internal class ThermalEventSources(context:Context) {
  private val manager=context.getSystemService(PowerManager::class.java)
  private val executor=Executor {Handler(Looper.getMainLooper()).post(it)}
  private val events=java.util.ArrayDeque<JSONObject>()
  private var total=0L
  private var statusListener:Any?=null
  private var headroomListener:Any?=null
  private var statusState="not_registered"
  private var headroomState="not_registered"
  private var active=false
  @Synchronized private fun event(row:JSONObject) {if(!active)return;++total;if(events.size>=64)events.removeFirst();events.addLast(row.put("receivedAtMs",System.currentTimeMillis()).put("receivedElapsedRealtimeNanos",SystemClock.elapsedRealtimeNanos().toString()))}
  @Synchronized fun start() {
    if(active)return;active=true
    if(Build.VERSION.SDK_INT>=29)try {val l=PowerManager.OnThermalStatusChangedListener {status->event(JSONObject().put("kind","status").put("status",status))};manager.addThermalStatusListener(executor,l);statusListener=l;statusState="registered"}catch(e:Exception){statusState=e.toString()} else statusState="requires_api_29"
    if(Build.VERSION.SDK_INT>=36)try {val l=PowerManager.OnThermalHeadroomChangedListener {headroom,forecast,seconds,thresholds->
      val values=JSONObject();for((k,v) in thresholds)values.put(k.toString(),if(v.isFinite())v else v.toString())
      event(JSONObject().put("kind","headroom").put("headroom",if(headroom.isFinite())headroom else headroom.toString()).put("forecastHeadroom",if(forecast.isFinite())forecast else forecast.toString()).put("forecastSeconds",seconds).put("thresholds",values))
    };manager.addThermalHeadroomListener(executor,l);headroomListener=l;headroomState="registered"}catch(e:Exception){headroomState=e.toString()} else headroomState="requires_api_36"
  }
  @Synchronized fun stop() {
    active=false
    if(Build.VERSION.SDK_INT>=29)(statusListener as? PowerManager.OnThermalStatusChangedListener)?.let {try{manager.removeThermalStatusListener(it);statusState="paused"}catch(e:Exception){statusState=e.toString()}}
    if(Build.VERSION.SDK_INT>=36)(headroomListener as? PowerManager.OnThermalHeadroomChangedListener)?.let {try{manager.removeThermalHeadroomListener(it);headroomState="paused"}catch(e:Exception){headroomState=e.toString()}}
    statusListener=null;headroomListener=null
  }
  @Synchronized fun snapshot()=JSONObject().put("statusListener",statusState).put("headroomListener",headroomState).put("totalCallbacks",total.toString()).put("events",JSONArray(events.toList())).put("note","Registration may deliver an initial value; callbacks are not necessarily transitions")
}
