cmake_minimum_required(VERSION 3.18)

project(wfloat LANGUAGES C CXX)

option(WFLOAT_BUILD_CORE "Build wfloat-core native targets" ON)
option(WFLOAT_ENABLE_LLAMA_CPP "Build wfloat-core LLM support with llama.cpp" ON)
option(WFLOAT_CORE_ENABLE_SPEECH "Build wfloat-core speech support with sherpa-onnx" ON)

# Build vendored dependencies with PIC so wrapper targets can expose shared
# libraries cleanly.
set(CMAKE_POSITION_INDEPENDENT_CODE ON)

if(MSVC AND NOT DEFINED CMAKE_MSVC_RUNTIME_LIBRARY)
  set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")
endif()

if(WFLOAT_BUILD_CORE)
  # On Linux, wrapping sherpa's static onnxruntime stack inside a second shared
  # library is crashing during recognizer creation. Match upstream sherpa's
  # shared-library mode so libwfloat-core.so uses the same packaging strategy as
  # a working libsherpa-onnx-c-api.so build.
  if(CMAKE_SYSTEM_NAME STREQUAL "Linux")
    set(BUILD_SHARED_LIBS ON CACHE BOOL "" FORCE)
    set(SHERPA_ONNX_LINK_LIBSTDCPP_STATICALLY OFF CACHE BOOL "" FORCE)
  endif()

  if(WFLOAT_CORE_ENABLE_SPEECH)
    add_subdirectory(vendor/sherpa-onnx)
  endif()
  if(WFLOAT_ENABLE_LLAMA_CPP)
    set(LLAMA_BUILD_COMMON OFF CACHE BOOL "" FORCE)
    set(LLAMA_BUILD_TESTS OFF CACHE BOOL "" FORCE)
    set(LLAMA_BUILD_TOOLS OFF CACHE BOOL "" FORCE)
    set(LLAMA_BUILD_EXAMPLES OFF CACHE BOOL "" FORCE)
    set(LLAMA_BUILD_SERVER OFF CACHE BOOL "" FORCE)
    set(LLAMA_BUILD_APP OFF CACHE BOOL "" FORCE)
    set(LLAMA_BUILD_UI OFF CACHE BOOL "" FORCE)
    set(LLAMA_OPENSSL OFF CACHE BOOL "" FORCE)
    set(GGML_METAL OFF CACHE BOOL "" FORCE)
    add_subdirectory(vendor/llama.cpp)
  endif()
  add_subdirectory(native/wfloat-core)
endif()
