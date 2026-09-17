package com.wfloat.bench

import android.content.Context
import android.os.Build
import android.os.PowerManager
import android.os.SystemClock
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.uimanager.ViewManager

class BenchThermalModule(context: ReactApplicationContext) : ReactContextBaseJavaModule(context) {
  override fun getName() = "BenchThermal"

  @ReactMethod
  fun read(promise: Promise) {
    try {
      val result = Arguments.createMap()
      result.putString("platform", "android")
      result.putString("osVersion", "${Build.VERSION.RELEASE} (API ${Build.VERSION.SDK_INT})")
      // Android has no universal public emulator flag. This identifies the local
      // Android Emulator; it must not be used as proof of physical hardware.
      val emulator = Build.FINGERPRINT.startsWith("generic") ||
        Build.HARDWARE.contains("ranchu") || Build.HARDWARE.contains("goldfish") ||
        Build.MODEL.contains("sdk_gphone")
      result.putString("environment", if (emulator) "emulator" else "device")
      result.putString("source", "PowerManager.getCurrentThermalStatus()")
      val power = reactApplicationContext.getSystemService(Context.POWER_SERVICE) as? PowerManager
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q || power == null) {
        result.putString("availability", "unavailable")
        result.putNull("state")
        result.putNull("rawValue")
        result.putString("note", "Thermal status requires Android API 29+ and a power service.")
      } else {
        val value = power.currentThermalStatus
        val state = when (value) {
          PowerManager.THERMAL_STATUS_NONE -> "NONE"
          PowerManager.THERMAL_STATUS_LIGHT -> "LIGHT"
          PowerManager.THERMAL_STATUS_MODERATE -> "MODERATE"
          PowerManager.THERMAL_STATUS_SEVERE -> "SEVERE"
          PowerManager.THERMAL_STATUS_CRITICAL -> "CRITICAL"
          PowerManager.THERMAL_STATUS_EMERGENCY -> "EMERGENCY"
          PowerManager.THERMAL_STATUS_SHUTDOWN -> "SHUTDOWN"
          else -> "UNKNOWN"
        }
        result.putString("availability", "available")
        result.putString("state", state)
        result.putInt("rawValue", value)
        result.putString("note", "NONE alone does not establish complete thermal support or absence of throttling.")
      }
      result.putDouble("sampledAtMs", System.currentTimeMillis().toDouble())
      result.putDouble("uptimeMs", SystemClock.elapsedRealtime().toDouble())
      promise.resolve(result)
    } catch (error: Exception) {
      promise.reject("THERMAL_READ_FAILED", "Could not read OS thermal status: ${error.message}", error)
    }
  }
}

class BenchThermalPackage : ReactPackage {
  override fun createNativeModules(context: ReactApplicationContext): List<NativeModule> =
    listOf(BenchSignalsModule(context), BenchThermalModule(context), BenchHeadroomModule(context), BenchCpuHeadroomModule(context), BenchPowerMonitorsModule(context), BenchBatteryModule(context), BenchCpuModule(context), BenchProcessCpuModule(context), BenchThreadsModule(context), BenchFileDescriptorsModule(context), BenchStorageIoModule(context), BenchNetworkModule(context), BenchContextSwitchesModule(context), BenchMemoryModule(context), BenchSystemMemoryModule(context), BenchPageFaultsModule(context), BenchFileFaultProbeModule(context))

  override fun createViewManagers(context: ReactApplicationContext): List<ViewManager<*, *>> = emptyList()
}
