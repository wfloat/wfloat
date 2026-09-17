package com.wfloat.bench

import android.content.Intent
import org.json.JSONArray
import org.json.JSONObject

/** Preserve delivered scalar extras, including OEM additions, without guessing units. */
internal object BatteryIntentSources {
  @Suppress("DEPRECATION")
  fun read(intent:Intent):JSONObject {
    val bundle=intent.extras?:return JSONObject().put("entries",JSONObject()).put("keyCount",0)
    val keys=bundle.keySet().sorted();val entries=JSONObject()
    fun scalar(value:Any?):Any?=when(value){
      null -> JSONObject.NULL
      is Boolean -> value
      is Byte,is Short,is Int,is Long,is Float,is Double -> value.toString()
      is Char -> value.toString()
      is String -> value.take(2048)
      else -> null
    }
    for(key in keys.take(128)) {
      val row=JSONObject()
      if(key.lowercase() in setOf("serial","serial_number","battery_serial","battery_serial_number")) {
        entries.put(key,row.put("omitted","identifier, not resource telemetry"));continue
      }
      try {
        val value=bundle.get(key);row.put("nativeType",value?.javaClass?.name?:"null")
        val simple=scalar(value)
        if(simple!=null)row.put("value",simple).put("truncated",value is String&&value.length>2048)
        else if(value!=null&&value.javaClass.isArray&&value.javaClass.componentType?.isPrimitive==true) {
          val length=java.lang.reflect.Array.getLength(value);val array=JSONArray()
          for(i in 0 until minOf(length,256))array.put(scalar(java.lang.reflect.Array.get(value,i)))
          row.put("value",array).put("length",length).put("truncated",length>256)
        } else row.put("omitted","non-scalar/non-primitive-array payload")
      } catch(e:Exception){row.put("error",e.toString())}
      entries.put(key,row)
    }
    return JSONObject().put("entries",entries).put("keyCount",keys.size).put("truncated",keys.size>128)
      .put("semantics","Delivered native extras; numeric values are exact strings with native type. Unknown keys retain unknown units/semantics. Receipt is not hardware sample time.")
  }
}
