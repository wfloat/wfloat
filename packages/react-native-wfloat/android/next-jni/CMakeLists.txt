cmake_minimum_required(VERSION 3.18)
project(wfloat_next_jni LANGUAGES C CXX)
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_POSITION_INDEPENDENT_CODE ON)
get_filename_component(PACKAGE_DIR "${CMAKE_CURRENT_LIST_DIR}/../.." ABSOLUTE)
get_filename_component(REPO_ROOT "${PACKAGE_DIR}/../.." ABSOLUTE)
set(WFLOAT_NEXT_REPO_ROOT "${REPO_ROOT}" CACHE PATH "Source repository supplying existing llama/sherpa dependencies")
set(BUILD_SHARED_LIBS OFF CACHE BOOL "" FORCE)
set(LLAMA_BUILD_COMMON ON CACHE BOOL "" FORCE)
foreach(flag LLAMA_BUILD_TESTS LLAMA_BUILD_TOOLS LLAMA_BUILD_EXAMPLES LLAMA_BUILD_SERVER LLAMA_BUILD_APP LLAMA_BUILD_UI LLAMA_OPENSSL LLAMA_SUBPROCESS GGML_NATIVE GGML_OPENMP GGML_METAL GGML_VULKAN GGML_OPENCL GGML_LLAMAFILE GGML_CPU_KLEIDIAI)
  set(${flag} OFF CACHE BOOL "" FORCE)
endforeach()
# Android x86 ABIs do not guarantee AVX/FMA. Keep published artifacts at the
# ABI baseline rather than inheriting host-oriented ggml defaults.
if(ANDROID_ABI MATCHES "^x86")
  foreach(flag GGML_AVX GGML_AVX2 GGML_FMA GGML_F16C GGML_BMI2)
    set(${flag} OFF CACHE BOOL "" FORCE)
  endforeach()
  if(ANDROID_ABI STREQUAL "x86")
    set(GGML_SSE42 OFF CACHE BOOL "" FORCE)
  endif()
endif()
set(ANDROID_SUPPORT_FLEXIBLE_PAGE_SIZES ON CACHE BOOL "" FORCE)
add_subdirectory("${WFLOAT_NEXT_REPO_ROOT}/vendor/llama.cpp" "${CMAKE_CURRENT_BINARY_DIR}/llama.cpp")
set(SHERPA_LIB "${PACKAGE_DIR}/android/src/main/jniLibs/${ANDROID_ABI}/libsherpa-onnx-c-api.so")
if(NOT EXISTS "${SHERPA_LIB}")
  message(FATAL_ERROR "Stage the existing sherpa native libraries before building WfloatNext (${ANDROID_ABI}).")
endif()
add_library(next-sherpa SHARED IMPORTED)
set_target_properties(next-sherpa PROPERTIES IMPORTED_LOCATION "${SHERPA_LIB}")
add_library(wfloat-next-jni SHARED next_jni.cpp
  "${PACKAGE_DIR}/cpp/NextRuntime.cpp"
  "${PACKAGE_DIR}/cpp/LlmRuntime.cpp"
  "${PACKAGE_DIR}/cpp/SpeechRuntime.cpp"
  "${WFLOAT_NEXT_REPO_ROOT}/native/wfloat-core/src/schema/validator.cc")
target_include_directories(wfloat-next-jni PRIVATE
  "${PACKAGE_DIR}/cpp"
  "${WFLOAT_NEXT_REPO_ROOT}/vendor/llama.cpp/vendor"
  "${WFLOAT_NEXT_REPO_ROOT}/vendor/sherpa-onnx"
  "${WFLOAT_NEXT_REPO_ROOT}/native/wfloat-core/src")
target_link_libraries(wfloat-next-jni PRIVATE llama llama-common next-sherpa log android)
target_link_options(wfloat-next-jni PRIVATE "-Wl,-z,max-page-size=16384" "-Wl,--exclude-libs,ALL")
include("${CMAKE_CURRENT_LIST_DIR}/sherpa-vad.cmake")
