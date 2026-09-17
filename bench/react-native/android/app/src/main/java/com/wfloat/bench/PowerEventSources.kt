package com.wfloat.bench
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.PowerManager
import android.os.BatteryManager
import android.os.Build
import android.os.SystemClock
import org.json.JSONObject
import org.json.JSONArray
internal class PowerEventSources(private val context:Context) {
  private val events=java.util.ArrayDeque<JSONObject>();private var total=0L;private var active=false;private var state="not_registered"
  private val receiver=object:BroadcastReceiver(){override fun onReceive(context:Context,intent:Intent){record(intent,isInitialStickyBroadcast)}}
  @Synchronized private fun record(intent:Intent,initial:Boolean){if(!active)return;val row=JSONObject().put("action",intent.action).put("initialSticky",initial).put("receivedAtMs",System.currentTimeMillis()).put("receivedElapsedRealtimeNanos",SystemClock.elapsedRealtimeNanos().toString())
    for(key in listOf("level","scale","status","health","plugged","temperature","voltage","cycle_count","charging_status","capacity_level"))if(intent.hasExtra(key))row.put(key,intent.getIntExtra(key,Int.MIN_VALUE))
    for(key in listOf("present",BatteryManager.EXTRA_BATTERY_LOW))if(intent.hasExtra(key))row.put(key,intent.getBooleanExtra(key,false))
    if(intent.hasExtra(BatteryManager.EXTRA_TECHNOLOGY))row.put("technology",intent.getStringExtra(BatteryManager.EXTRA_TECHNOLOGY)?:JSONObject.NULL)
    row.put("rawExtras",BatteryIntentSources.read(intent))
    val p=context.getSystemService(PowerManager::class.java);row.put("isPowerSaveMode",p.isPowerSaveMode).put("isDeviceIdleMode",p.isDeviceIdleMode).put("isInteractive",p.isInteractive)
    if(Build.VERSION.SDK_INT>=33)row.put("isDeviceLightIdleMode",p.isDeviceLightIdleMode).put("isLowPowerStandbyEnabled",p.isLowPowerStandbyEnabled)
    ++total;if(events.size>=64)events.removeFirst();events.addLast(row)
  }
  @Synchronized fun start(){if(active)return;active=true;try{val f=IntentFilter();for(action in listOf(Intent.ACTION_BATTERY_CHANGED,Intent.ACTION_BATTERY_LOW,Intent.ACTION_BATTERY_OKAY,BatteryManager.ACTION_CHARGING,BatteryManager.ACTION_DISCHARGING,PowerManager.ACTION_DEVICE_LIGHT_IDLE_MODE_CHANGED,PowerManager.ACTION_LOW_POWER_STANDBY_ENABLED_CHANGED,PowerManager.ACTION_LOW_POWER_STANDBY_POLICY_CHANGED,Intent.ACTION_POWER_CONNECTED,Intent.ACTION_POWER_DISCONNECTED,Intent.ACTION_SCREEN_ON,Intent.ACTION_SCREEN_OFF,PowerManager.ACTION_POWER_SAVE_MODE_CHANGED,PowerManager.ACTION_DEVICE_IDLE_MODE_CHANGED))f.addAction(action);context.registerReceiver(receiver,f);state="registered"}catch(e:Exception){active=false;state=e.toString()}}
  @Synchronized fun stop(){if(active)try{context.unregisterReceiver(receiver);state="paused"}catch(e:Exception){state=e.toString()};active=false}
  @Synchronized fun snapshot()=JSONObject().put("registration",state).put("totalCallbacks",total.toString()).put("events",JSONArray(events.toList())).put("scope","foreground battery/power/lifecycle broadcasts; receipt time is not sensor sampling time")
}
