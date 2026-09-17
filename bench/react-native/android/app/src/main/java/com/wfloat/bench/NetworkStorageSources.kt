package com.wfloat.bench
import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.net.wifi.WifiManager
import android.os.Build
import android.os.Process
import android.os.SystemClock
import android.os.storage.StorageManager
import android.app.usage.StorageStats
import android.app.usage.StorageStatsManager
import org.json.JSONArray
import org.json.JSONObject

internal object NetworkSources {
  fun read(context:Context):JSONObject {
    val rows=JSONObject();fun query(name:String,read:()->JSONObject){try{rows.put(name,read())}catch(e:Exception){rows.put(name,JSONObject().put("error","${e.javaClass.simpleName}: ${e.message}"))}}
    query("activeNetwork") {
      val manager=context.getSystemService(ConnectivityManager::class.java);val network=manager.activeNetwork
      val out=JSONObject().put("present",network!=null);val caps=network?.let{manager.getNetworkCapabilities(it)};val links=network?.let{manager.getLinkProperties(it)}
      if(caps!=null){out.put("downstreamBandwidthKbps",caps.linkDownstreamBandwidthKbps).put("upstreamBandwidthKbps",caps.linkUpstreamBandwidthKbps).put("capabilities",JSONArray(if(Build.VERSION.SDK_INT>=31)caps.capabilities.toList() else (0..25).filter{caps.hasCapability(it)})).put("transports",JSONArray((0..10).filter{caps.hasTransport(it)}));if(Build.VERSION.SDK_INT>=29)out.put("signalStrengthRaw",caps.signalStrength)}
      if(links!=null)out.put("mtu",links.mtu).put("interfaceName",links.interfaceName?:JSONObject.NULL)
      out.put("isActiveNetworkMetered",manager.isActiveNetworkMetered).put("restrictBackgroundStatus",manager.restrictBackgroundStatus)
    }
    query("wifi") {
      @Suppress("DEPRECATION") val info=context.applicationContext.getSystemService(WifiManager::class.java).connectionInfo
      val v=JSONObject().put("rssiDbm",info.rssi).put("linkSpeedMbps",info.linkSpeed).put("frequencyMhz",info.frequency).put("supplicantState",info.supplicantState.name)
      if(Build.VERSION.SDK_INT>=29)v.put("txLinkSpeedMbps",info.txLinkSpeedMbps).put("rxLinkSpeedMbps",info.rxLinkSpeedMbps)
      if(Build.VERSION.SDK_INT>=30)v.put("maxSupportedTxLinkSpeedMbps",info.maxSupportedTxLinkSpeedMbps).put("maxSupportedRxLinkSpeedMbps",info.maxSupportedRxLinkSpeedMbps).put("wifiStandard",info.wifiStandard)
      v.put("unknownLinkSpeedSentinel",-1).put("invalidRssiSentinel",-127)
    }
    return rows.put("scope","current network/link estimates, not measured throughput; no network addresses or identifiers collected")
  }
}
internal class StorageSources(private val context:Context) {
  private var last:JSONObject?=null;private var at=0L
  fun read():JSONObject {
    val now=SystemClock.elapsedRealtime();if(last!=null&&now-at<60000)return JSONObject().put("sample",JSONObject(last.toString())).put("cacheAgeMs",now-at).put("minimumIntervalMs",60000)
    check(Build.VERSION.SDK_INT>=26){"requires API 26"};val began=SystemClock.elapsedRealtime();val manager=context.getSystemService(StorageManager::class.java);val uuid=manager.getUuidForPath(context.filesDir);val rows=JSONObject()
    fun query(name:String,read:()->Any){val started=SystemClock.elapsedRealtime();try{rows.put(name,JSONObject().put("value",read()).put("error",JSONObject.NULL))}catch(e:Exception){rows.put(name,JSONObject().put("value",JSONObject.NULL).put("error","${e.javaClass.simpleName}: ${e.message}"))};rows.getJSONObject(name).put("startedUptimeMs",started).put("finishedUptimeMs",SystemClock.elapsedRealtime())}
    query("allocatableBytes"){manager.getAllocatableBytes(uuid).toString()};query("cacheQuotaBytes"){manager.getCacheQuotaBytes(uuid).toString()};query("cacheSizeBytes"){manager.getCacheSizeBytes(uuid).toString()}
    val stats=context.getSystemService(StorageStatsManager::class.java)
    query("ownUidStorageStats"){val s=stats.queryStatsForUid(uuid,Process.myUid());JSONObject().put("appBytes",s.appBytes.toString()).put("dataBytes",s.dataBytes.toString()).put("cacheBytes",s.cacheBytes.toString()).apply{if(Build.VERSION.SDK_INT>=31)put("externalCacheBytes",s.externalCacheBytes.toString())
      if(Build.VERSION.SDK_INT>=35){val parts=JSONObject();for((name,type) in listOf("APK" to StorageStats.APP_DATA_TYPE_FILE_TYPE_APK,"CURRENT_PROFILE" to StorageStats.APP_DATA_TYPE_FILE_TYPE_CURRENT_PROFILE,"DEXOPT_ARTIFACT" to StorageStats.APP_DATA_TYPE_FILE_TYPE_DEXOPT_ARTIFACT,"DM" to StorageStats.APP_DATA_TYPE_FILE_TYPE_DM,"REFERENCE_PROFILE" to StorageStats.APP_DATA_TYPE_FILE_TYPE_REFERENCE_PROFILE,"LIB" to StorageStats.APP_DATA_TYPE_LIB))parts.put(name,s.getAppBytesByDataType(type).toString());put("appBytesByDataType",parts)}}}
    query("volumeTotalBytes"){stats.getTotalBytes(uuid).toString()};query("volumeFreeBytes"){stats.getFreeBytes(uuid).toString()}
    at=SystemClock.elapsedRealtime();last=JSONObject().put("startedUptimeMs",began).put("finishedUptimeMs",at).put("observations",rows).put("scope","own UID and app-files volume; OS accounting and reclaim-policy estimates, no allocation or cache deletion requested")
    return JSONObject().put("sample",JSONObject(last.toString())).put("cacheAgeMs",0).put("minimumIntervalMs",60000)
  }
}
