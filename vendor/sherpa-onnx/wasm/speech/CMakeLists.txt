if(NOT $ENV{SHERPA_ONNX_IS_USING_BUILD_WASM_SH})
  message(FATAL_ERROR "Please use ./build-wasm-simd-speech.sh to build shared browser speech WASM")
endif()

set(exported_functions
  # helpers
  CopyHeap
  PrintOfflineTtsConfig
  PrintOfflineRecognizerConfig
  SherpaOnnxGetVersionStr
  SherpaOnnxGetGitDate
  SherpaOnnxGetGitSha1
  SherpaOnnxFileExists
  SherpaOnnxReadWave
  SherpaOnnxReadWaveFromBinaryData
  SherpaOnnxFreeWave
  SherpaOnnxWriteWave

  # TTS
  SherpaOnnxCreateOfflineTts
  SherpaOnnxDestroyOfflineTts
  SherpaOnnxDestroyOfflineTtsGeneratedAudio
  SherpaOnnxOfflineTtsGenerate
  SherpaOnnxOfflineTtsGenerateWithCallback
  SherpaOnnxOfflineTtsGenerateWithProgressCallback
  SherpaOnnxOfflineTtsWfloatPrepareText
  SherpaOnnxOfflineTtsWfloatFreePreparedText
  SherpaOnnxOfflineTtsNumSpeakers
  SherpaOnnxOfflineTtsSampleRate

  # offline ASR
  SherpaOnnxAcceptWaveformOffline
  SherpaOnnxCreateOfflineRecognizer
  SherpaOnnxCreateOfflineStream
  SherpaOnnxDecodeMultipleOfflineStreams
  SherpaOnnxDecodeOfflineStream
  SherpaOnnxDestroyOfflineRecognizer
  SherpaOnnxDestroyOfflineRecognizerResult
  SherpaOnnxDestroyOfflineStream
  SherpaOnnxDestroyOfflineStreamResultJson
  SherpaOnnxGetOfflineStreamResult
  SherpaOnnxGetOfflineStreamResultAsJson
  SherpaOnnxOfflineRecognizerSetConfig

  # online ASR
  SherpaOnnxCreateOnlineRecognizer
  SherpaOnnxCreateOnlineStream
  SherpaOnnxDecodeOnlineStream
  SherpaOnnxDestroyOnlineRecognizer
  SherpaOnnxDestroyOnlineRecognizerResult
  SherpaOnnxDestroyOnlineStream
  SherpaOnnxDestroyOnlineStreamResultJson
  SherpaOnnxGetOnlineStreamResult
  SherpaOnnxGetOnlineStreamResultAsJson
  SherpaOnnxIsOnlineStreamReady
  SherpaOnnxOnlineStreamAcceptWaveform
  SherpaOnnxOnlineStreamInputFinished
  SherpaOnnxOnlineStreamIsEndpoint
  SherpaOnnxOnlineStreamReset

  # VAD
  SherpaOnnxCreateCircularBuffer
  SherpaOnnxDestroyCircularBuffer
  SherpaOnnxCircularBufferPush
  SherpaOnnxCircularBufferGet
  SherpaOnnxCircularBufferFree
  SherpaOnnxCircularBufferPop
  SherpaOnnxCircularBufferSize
  SherpaOnnxCircularBufferHead
  SherpaOnnxCircularBufferReset
  SherpaOnnxCreateVoiceActivityDetector
  SherpaOnnxDestroyVoiceActivityDetector
  SherpaOnnxVoiceActivityDetectorAcceptWaveform
  SherpaOnnxVoiceActivityDetectorEmpty
  SherpaOnnxVoiceActivityDetectorDetected
  SherpaOnnxVoiceActivityDetectorPop
  SherpaOnnxVoiceActivityDetectorClear
  SherpaOnnxVoiceActivityDetectorFront
  SherpaOnnxDestroySpeechSegment
  SherpaOnnxVoiceActivityDetectorReset
  SherpaOnnxVoiceActivityDetectorFlush
)

set(mangled_exported_functions)
foreach(x IN LISTS exported_functions)
  list(APPEND mangled_exported_functions "_${x}")
endforeach()
list(JOIN mangled_exported_functions "," all_exported_functions)

include_directories(${CMAKE_SOURCE_DIR})
set(MY_FLAGS " -s FORCE_FILESYSTEM=1 -s INITIAL_MEMORY=512MB -s ALLOW_MEMORY_GROWTH=1 -s ALLOW_TABLE_GROWTH=1")
string(APPEND MY_FLAGS " -sSTACK_SIZE=10485760 ")
string(APPEND MY_FLAGS " -sEXPORTED_FUNCTIONS=[_malloc,_free,${all_exported_functions}] ")
string(APPEND MY_FLAGS " -sEXPORTED_RUNTIME_METHODS=['FS','ccall','stringToUTF8','setValue','getValue','lengthBytesUTF8','UTF8ToString','UTF8ArrayToString','wasmMemory','stackSave','stackRestore','addFunction','removeFunction'] ")
string(APPEND MY_FLAGS " -s MODULARIZE=1 ")
string(APPEND MY_FLAGS " -s EXPORT_ES6=1 ")
string(APPEND MY_FLAGS " -s ENVIRONMENT=web ")

message(STATUS "MY_FLAGS: ${MY_FLAGS}")

set(CMAKE_C_FLAGS "${CMAKE_C_FLAGS} ${MY_FLAGS}")
set(CMAKE_CXX_FLAGS "${CMAKE_CXX_FLAGS} ${MY_FLAGS}")
set(CMAKE_EXECUTABLE_LINKER_FLAGS "${CMAKE_EXECUTABLE_LINKER_FLAGS} ${MY_FLAGS}")

if (NOT CMAKE_EXECUTABLE_SUFFIX STREQUAL ".js")
  message(FATAL_ERROR "The default suffix for building executables should be .js!")
endif()

add_executable(sherpa-onnx-wasm-main-speech sherpa-onnx-wasm-main-speech.cc)
target_link_libraries(sherpa-onnx-wasm-main-speech sherpa-onnx-core sherpa-onnx-c-api)
install(TARGETS sherpa-onnx-wasm-main-speech DESTINATION bin/wasm/speech)

install(
  FILES
    ${CMAKE_SOURCE_DIR}/wasm/asr/sherpa-onnx-asr.js
    ${CMAKE_SOURCE_DIR}/wasm/tts/sherpa-onnx-tts.js
    ${CMAKE_SOURCE_DIR}/wasm/vad/sherpa-onnx-vad.js
    "$<TARGET_FILE_DIR:sherpa-onnx-wasm-main-speech>/sherpa-onnx-wasm-main-speech.js"
    "$<TARGET_FILE_DIR:sherpa-onnx-wasm-main-speech>/sherpa-onnx-wasm-main-speech.wasm"
  DESTINATION
    bin/wasm/speech
)
