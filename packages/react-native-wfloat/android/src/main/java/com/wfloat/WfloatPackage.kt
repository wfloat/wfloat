package com.wfloat

import com.facebook.react.BaseReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.module.model.ReactModuleInfo
import com.facebook.react.module.model.ReactModuleInfoProvider
import java.util.HashMap

class WfloatPackage : BaseReactPackage() {
  override fun getModule(name: String, reactContext: ReactApplicationContext): NativeModule? {
    return if (name == WfloatModule.NAME) {
      WfloatModule(reactContext)
    } else if (name == WfloatNextModule.NAME) {
      WfloatNextModule(reactContext)
    } else {
      null
    }
  }

  override fun getReactModuleInfoProvider(): ReactModuleInfoProvider {
    return ReactModuleInfoProvider {
      val moduleInfos: MutableMap<String, ReactModuleInfo> = HashMap()
      moduleInfos[WfloatModule.NAME] = ReactModuleInfo(
        WfloatModule.NAME,
        WfloatModule.NAME,
        false,  // canOverrideExistingModule
        false,  // needsEagerInit
        true,  // hasConstants
        false,  // isCxxModule
        true // isTurboModule
      )
      moduleInfos[WfloatNextModule.NAME] = ReactModuleInfo(
        WfloatNextModule.NAME, WfloatNextModule.NAME, false, false, false, false, true
      )
      moduleInfos
    }
  }
}
