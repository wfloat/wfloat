cmake_minimum_required(VERSION 3.18)

project(wfloat LANGUAGES C CXX)

option(WFLOAT_BUILD_CORE "Build wfloat-core native targets" ON)

if(WFLOAT_BUILD_CORE)
  add_subdirectory(vendor/sherpa-onnx)
  add_subdirectory(native/wfloat-core)
endif()
