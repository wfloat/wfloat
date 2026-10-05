# Compile the matching vendor's real raw-probability VAD implementation. The
# staged Sherpa C ABI intentionally hides these C++ symbols. Reuse locally
# populated dependencies from existing Sherpa builds; never FetchContent/download.
set(SHERPA_SOURCE "${WFLOAT_NEXT_REPO_ROOT}/vendor/sherpa-onnx")
set(WFLOAT_SHERPA_DEPS_DIR "${SHERPA_SOURCE}/build-wasm-simd-speech/_deps" CACHE PATH "Previously populated Sherpa dependency source directory")
set(WFLOAT_ORT_HEADERS "${WFLOAT_SHERPA_DEPS_DIR}/onnxruntime-src/include" CACHE PATH "Headers supported by the staged Android ONNX Runtime")
foreach(required eigen-src/Eigen/Dense kaldi_native_fbank-src/kaldi-native-fbank/csrc/rfft.cc kissfft-src/kiss_fft.c)
  if(NOT EXISTS "${WFLOAT_SHERPA_DEPS_DIR}/${required}")
    message(FATAL_ERROR "Missing existing dependency ${required}; set WFLOAT_SHERPA_DEPS_DIR to an already-populated Sherpa _deps directory")
  endif()
endforeach()
if(NOT EXISTS "${WFLOAT_ORT_HEADERS}/onnxruntime_cxx_api.h")
  message(FATAL_ERROR "Set WFLOAT_ORT_HEADERS to matching existing ONNX Runtime headers")
endif()
set(VAD_SOURCES vad-model.cc vad-model-config.cc silero-vad-model.cc silero-vad-model-config.cc
  ten-vad-model.cc ten-vad-model-config.cc session.cc provider.cc onnx-utils.cc file-utils.cc text-utils.cc parse-options.cc log.cc)
foreach(source IN LISTS VAD_SOURCES)
  target_sources(wfloat-next-jni PRIVATE "${SHERPA_SOURCE}/sherpa-onnx/csrc/${source}")
endforeach()
foreach(source rfft.cc mel-computations.cc kaldi-math.cc feature-functions.cc feature-window.cc)
  target_sources(wfloat-next-jni PRIVATE "${WFLOAT_SHERPA_DEPS_DIR}/kaldi_native_fbank-src/kaldi-native-fbank/csrc/${source}")
endforeach()
target_sources(wfloat-next-jni PRIVATE "${WFLOAT_SHERPA_DEPS_DIR}/kissfft-src/kiss_fft.c" "${WFLOAT_SHERPA_DEPS_DIR}/kissfft-src/kiss_fftr.c")
target_include_directories(wfloat-next-jni PRIVATE "${WFLOAT_ORT_HEADERS}" "${WFLOAT_SHERPA_DEPS_DIR}/eigen-src"
  "${WFLOAT_SHERPA_DEPS_DIR}/kaldi_native_fbank-src" "${WFLOAT_SHERPA_DEPS_DIR}/kissfft-src")
# Keep internal VAD and ORT C++ wrappers local to this image, avoiding interposition
# with the legacy Sherpa shared libraries. JNIEXPORT retains public JNI symbols.
set_target_properties(wfloat-next-jni PROPERTIES CXX_VISIBILITY_PRESET hidden C_VISIBILITY_PRESET hidden VISIBILITY_INLINES_HIDDEN ON)
target_link_libraries(wfloat-next-jni PRIVATE "${PACKAGE_DIR}/android/src/main/jniLibs/${ANDROID_ABI}/libonnxruntime.so")
