package com.wfloat.bench

import android.os.IBinder
import android.os.Parcel
import java.lang.reflect.InvocationTargetException

/** Experimental access probe. This is not a public Android API or a sensor-sampling API. */
internal fun requestBatteryHealthRefresh(apiLevel: Int): Map<String, Any?> {
  // Verified AOSP IBatteryPropertiesRegistrar.aidl: Android 10 through 16 use
  // getProperty followed by oneway scheduleUpdate. Android 9 has a different layout;
  // Android 7 lacks scheduleUpdate. Never guess a transaction on an unverified API.
  // https://android.googlesource.com/platform/frameworks/base/+/android-10.0.0_r1/core/java/android/os/IBatteryPropertiesRegistrar.aidl
  // https://android.googlesource.com/platform/frameworks/base/+/android-16.0.0_r1/core/java/android/os/IBatteryPropertiesRegistrar.aidl
  if (apiLevel !in 29..36) return mapOf("outcome" to "unverified_api", "detail" to "No verified interface layout for API $apiLevel.")
  return try {
    // Ordinary app identity, no hidden-API exemptions, shell helper or permission grants.
    // Lookup may be rejected by Android's non-SDK interface restrictions.
    val manager = Class.forName("android.os.ServiceManager")
    val binder = manager.getMethod("getService", String::class.java)
      .invoke(null, "batteryproperties") as? IBinder
      ?: return mapOf("outcome" to "service_missing", "detail" to "Battery properties service was not accessible.")
    val descriptor = "android.os.IBatteryPropertiesRegistrar"
    if (binder.interfaceDescriptor != descriptor)
      return mapOf("outcome" to "interface_mismatch", "detail" to "Unexpected battery service interface; no request sent.")
    val data = Parcel.obtain()
    val sent = try {
      data.writeInterfaceToken(descriptor)
      binder.transact(IBinder.FIRST_CALL_TRANSACTION + 1, data, null, IBinder.FLAG_ONEWAY)
    } finally { data.recycle() }
    mapOf(
      "outcome" to if (sent) "request_sent" else "transport_rejected",
      "detail" to if (sent) "One-way request sent. Service execution and sensor freshness are unverified."
        else "Binder did not accept the transaction.",
      "transactionCode" to 2
    )
  } catch (error: Exception) {
    val cause = if (error is InvocationTargetException) error.targetException else error
    val denied = cause is SecurityException || cause is NoSuchMethodException || cause is IllegalAccessException
    mapOf("outcome" to if (denied) "access_blocked" else "request_failed", "detail" to cause.javaClass.simpleName)
  } catch (error: LinkageError) {
    mapOf("outcome" to "access_blocked", "detail" to error.javaClass.simpleName)
  }
}
