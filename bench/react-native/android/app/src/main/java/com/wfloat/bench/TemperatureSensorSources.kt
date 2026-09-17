package com.wfloat.bench
import android.content.Context
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.os.SystemClock
import org.json.JSONArray
import org.json.JSONObject
/** Optional framework thermometers, distinct from battery and thermal severity. */
internal class TemperatureSensorSources(context:Context):SensorEventListener {
  private val manager=context.getSystemService(SensorManager::class.java)
  private val events=java.util.ArrayDeque<JSONObject>();private val sensors=JSONArray()
  private var active=false;private var total=0L;private var state="not_registered"
  @Suppress("DEPRECATION") @Synchronized fun start(){
    if(active)return;active=true
    while(sensors.length()>0)sensors.remove(sensors.length()-1)
    try {
      val found=(manager.getSensorList(Sensor.TYPE_AMBIENT_TEMPERATURE)+manager.getSensorList(Sensor.TYPE_TEMPERATURE)).distinct()
      for(s in found.take(16)) {
        val row=JSONObject().put("id",s.id).put("type",s.type).put("stringType",s.stringType).put("name",s.name).put("vendor",s.vendor).put("version",s.version)
          .put("maximumRangeCelsius",s.maximumRange.toString()).put("resolutionCelsius",s.resolution.toString()).put("declaredPowerMilliAmps",s.power.toString())
          .put("minimumDelayMicroseconds",s.minDelay).put("maximumDelayMicroseconds",s.maxDelay).put("fifoReservedEvents",s.fifoReservedEventCount).put("fifoMaximumEvents",s.fifoMaxEventCount)
          .put("reportingMode",s.reportingMode).put("wakeUpSensor",s.isWakeUpSensor).put("dynamicSensor",s.isDynamicSensor)
        try {row.put("registered",manager.registerListener(this,s,1_000_000))}catch(e:Exception){row.put("registered",false).put("error",e.toString())}
        sensors.put(row)
      }
      state=if(found.isEmpty()) "no_temperature_sensors_exposed" else if(found.size>16) "sensor_limit_reached" else "enumerated"
    }catch(e:Exception){state=e.toString()}
  }
  @Synchronized fun stop(){active=false;manager.unregisterListener(this);state="paused"}
  @Synchronized override fun onSensorChanged(event:SensorEvent){
    if(!active)return
    val row=JSONObject().put("kind","sample").put("sensorId",event.sensor.id).put("sensorType",event.sensor.type).put("sensorTimestampNanos",event.timestamp.toString())
      .put("receivedElapsedRealtimeNanos",SystemClock.elapsedRealtimeNanos().toString()).put("receivedAtMs",System.currentTimeMillis()).put("accuracy",event.accuracy)
      .put("rawValues",JSONArray(event.values.map {it.toString()}))
    ++total;if(events.size>=64)events.removeFirst();events.addLast(row)
  }
  @Synchronized override fun onAccuracyChanged(sensor:Sensor,accuracy:Int) {
    if(!active)return
    if(events.size>=64)events.removeFirst();events.addLast(JSONObject().put("kind","accuracy").put("sensorId",sensor.id).put("sensorType",sensor.type).put("accuracy",accuracy).put("receivedAtMs",System.currentTimeMillis()))
  }
  @Synchronized fun snapshot()=JSONObject().put("state",state).put("requestedPeriodMicroseconds",1_000_000).put("sensors",JSONArray(sensors.toString())).put("sampleCallbacks",total.toString()).put("events",JSONArray(events.toList()))
    .put("scope","ambient Celsius or legacy device-temperature Celsius according to native sensor type; legacy implementation varies; requested delay is not a guaranteed sampling rate")
}
