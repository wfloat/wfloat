cmake_minimum_required(VERSION 3.18)

project(wfloat LANGUAGES C CXX)

option(WFLOAT_BUILD_CORE "Build wfloat-core native targets" ON)

# Build vendored dependencies with PIC so wrapper targets can expose shared
# libraries cleanly.
set(CMAKE_POSITION_INDEPENDENT_CODE ON)

if(WFLOAT_BUILD_CORE)
  # On Linux, wrapping sherpa's static onnxruntime stack inside a second shared
  # library is crashing during recognizer creation. Match upstream sherpa's
  # shared-library mode so libwfloat-core.so uses the same packaging strategy as
  # a working libsherpa-onnx-c-api.so build.
  if(CMAKE_SYSTEM_NAME STREQUAL "Linux")
    set(BUILD_SHARED_LIBS ON CACHE BOOL "" FORCE)
    set(SHERPA_ONNX_LINK_LIBSTDCPP_STATICALLY OFF CACHE BOOL "" FORCE)
  endif()

  add_subdirectory(vendor/sherpa-onnx)
  add_subdirectory(native/wfloat-core)
endif()
