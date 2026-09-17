package com.wfloat.bench
import android.content.Context
import android.os.Build
import android.telephony.TelephonyManager
import org.json.JSONArray
import org.json.JSONObject

internal object CellularSignalSources {
  // Only parameterless public SDK36.1 getters on cached signal value objects.
  // No cell identities, subscription details, radio scan or update request.
  private val getters=mapOf(
    "SignalStrength" to listOf("getCdmaDbm","getCdmaEcio","getEvdoDbm","getEvdoEcio","getEvdoSnr","getGsmBitErrorRate","getGsmSignalStrength","getLevel","getTimestampMillis","isGsm"),
    "CellSignalStrengthCdma" to listOf("getAsuLevel","getCdmaDbm","getCdmaEcio","getCdmaLevel","getDbm","getEvdoDbm","getEvdoEcio","getEvdoLevel","getEvdoSnr","getLevel"),
    "CellSignalStrengthGsm" to listOf("getAsuLevel","getBitErrorRate","getDbm","getLevel","getRssi","getTimingAdvance"),
    "CellSignalStrengthLte" to listOf("getAsuLevel","getCqi","getCqiTableIndex","getDbm","getLevel","getRsrp","getRsrq","getRssi","getRssnr","getTimingAdvance"),
    "CellSignalStrengthNr" to listOf("getAsuLevel","getCsiCqiReport","getCsiCqiTableIndex","getCsiRsrp","getCsiRsrq","getCsiSinr","getDbm","getLevel","getSsRsrp","getSsRsrq","getSsSinr","getTimingAdvanceMicros"),
    "CellSignalStrengthTdscdma" to listOf("getAsuLevel","getDbm","getLevel","getRscp"),
    "CellSignalStrengthWcdma" to listOf("getAsuLevel","getDbm","getEcNo","getLevel")
  )
  private fun record(value:Any):JSONObject {
    val fields=JSONObject();val names=getters[value.javaClass.simpleName]?:emptyList()
    for(name in names)try {
      val v=value.javaClass.getMethod(name).invoke(value)
      fields.put(name,JSONObject().put("value",when(v){is Number->v.toString();is Boolean->v;is List<*>->JSONArray(v.take(256));else->JSONObject.NULL}).put("error",JSONObject.NULL))
    }catch(e:Exception){fields.put(name,JSONObject().put("value",JSONObject.NULL).put("error","${e.javaClass.simpleName}: ${e.cause?.javaClass?.simpleName?:e.message}"))}
    return JSONObject().put("nativeType",value.javaClass.simpleName).put("fields",fields)
  }
  fun read(context:Context):JSONObject {
    check(Build.VERSION.SDK_INT>=28){"requires API28"}
    val signal=context.getSystemService(TelephonyManager::class.java).signalStrength
    val out=JSONObject().put("present",signal!=null).put("scope","Most recent cached modem signal, not requested fresh measurements; native technology-specific units and unavailable sentinels. No cell/location/subscriber identifiers.")
    if(signal!=null){out.put("summary",record(signal));if(Build.VERSION.SDK_INT>=29)out.put("technologies",JSONArray(signal.cellSignalStrengths.take(32).map {record(it)}))}
    return out
  }
}
