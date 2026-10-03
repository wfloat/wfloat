cmake_minimum_required(VERSION 3.14)

project(wfloat-llama-wasm C CXX)

if (NOT EMSCRIPTEN)
  message(FATAL_ERROR "wfloat-llama-wasm must be built with Emscripten. Use emcmake cmake.")
endif()

set(LLAMA_CPP_DIR "${CMAKE_CURRENT_SOURCE_DIR}/../../../../vendor/llama.cpp" CACHE PATH "Path to vendored llama.cpp")

set(BUILD_SHARED_LIBS OFF CACHE BOOL "" FORCE)
set(LLAMA_BUILD_COMMON ON CACHE BOOL "" FORCE)
set(LLAMA_BUILD_TESTS OFF CACHE BOOL "" FORCE)
set(LLAMA_BUILD_TOOLS OFF CACHE BOOL "" FORCE)
set(LLAMA_BUILD_EXAMPLES OFF CACHE BOOL "" FORCE)
set(LLAMA_BUILD_SERVER OFF CACHE BOOL "" FORCE)
set(LLAMA_BUILD_APP OFF CACHE BOOL "" FORCE)
set(LLAMA_BUILD_UI OFF CACHE BOOL "" FORCE)
set(LLAMA_USE_PREBUILT_UI OFF CACHE BOOL "" FORCE)
set(LLAMA_BUILD_HTML OFF CACHE BOOL "" FORCE)
set(LLAMA_WASM_MEM64 OFF CACHE BOOL "" FORCE)
set(LLAMA_OPENSSL OFF CACHE BOOL "" FORCE)
set(LLAMA_SUBPROCESS OFF CACHE BOOL "" FORCE)
set(GGML_OPENMP OFF CACHE BOOL "" FORCE)
set(GGML_NATIVE OFF CACHE BOOL "" FORCE)

add_compile_options(-fexceptions)

add_subdirectory("${LLAMA_CPP_DIR}" "${CMAKE_BINARY_DIR}/llama.cpp")

# llama-common's asynchronous logger requires pthreads. Select our synchronous
# WASM adapter at the build boundary without modifying vendored source.
get_target_property(WFLOAT_COMMON_SOURCES llama-common SOURCES)
list(FILTER WFLOAT_COMMON_SOURCES EXCLUDE REGEX "(^|/)log[.]cpp$")
set_property(TARGET llama-common PROPERTY SOURCES "${WFLOAT_COMMON_SOURCES}")
target_sources(llama-common PRIVATE "${CMAKE_CURRENT_SOURCE_DIR}/common_log_wasm.cpp")

set(CMAKE_RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}")

set(WFLOAT_CORE_DIR "${CMAKE_CURRENT_SOURCE_DIR}/../../../../native/wfloat-core")
add_executable(wfloat-llama-wasm llama_wasm.cpp round_runtime.cpp
  "${WFLOAT_CORE_DIR}/src/schema/validator.cc")
target_include_directories(wfloat-llama-wasm PRIVATE "${WFLOAT_CORE_DIR}/src")
set_target_properties(wfloat-llama-wasm PROPERTIES SUFFIX ".js")
target_compile_features(wfloat-llama-wasm PRIVATE cxx_std_17)
target_compile_options(wfloat-llama-wasm PRIVATE -fexceptions)
target_link_libraries(wfloat-llama-wasm PRIVATE llama llama-common)

target_link_options(wfloat-llama-wasm PRIVATE
  "SHELL:-fexceptions"
  "SHELL:-s DISABLE_EXCEPTION_CATCHING=0"
  "SHELL:-s MODULARIZE=1"
  "SHELL:-s EXPORT_ES6=1"
  "SHELL:-s ENVIRONMENT=web,worker"
  "SHELL:-s ALLOW_MEMORY_GROWTH=1"
  "SHELL:-s INITIAL_MEMORY=268435456"
  "SHELL:-s STACK_SIZE=8388608"
  "SHELL:-s FILESYSTEM=1"
  "SHELL:-s NO_EXIT_RUNTIME=1"
  "SHELL:-s ALLOW_TABLE_GROWTH=1"
  "SHELL:-s EXPORTED_RUNTIME_METHODS=['ccall','cwrap','FS','UTF8ToString','stringToUTF8','lengthBytesUTF8','setValue','getValue','addFunction','removeFunction']"
  "SHELL:-s EXPORTED_FUNCTIONS=['_malloc','_free','_wfloat_native_create','_wfloat_native_destroy','_wfloat_native_context_size','_wfloat_native_count','_wfloat_native_begin','_wfloat_native_step','_wfloat_native_round_destroy','_wfloat_native_schema','_wfloat_native_last_error','_wfloat_native_free_string','_wfloat_llama_model_create','_wfloat_llama_model_destroy','_wfloat_llama_model_generate_json','_wfloat_llama_model_format_chat','_wfloat_llama_free_string','_wfloat_llama_last_error']"
)

option(WFLOAT_LLAMA_PARSER_TEST "Build native boundary parser tests for Node" OFF)
if (WFLOAT_LLAMA_PARSER_TEST)
  add_executable(wfloat-llama-parser-test parser_test.cpp "${WFLOAT_CORE_DIR}/src/schema/validator.cc")
  set_target_properties(wfloat-llama-parser-test PROPERTIES SUFFIX ".cjs")
  target_compile_features(wfloat-llama-parser-test PRIVATE cxx_std_17)
  target_include_directories(wfloat-llama-parser-test PRIVATE "${WFLOAT_CORE_DIR}/src")
  target_link_libraries(wfloat-llama-parser-test PRIVATE llama-common)
  target_link_options(wfloat-llama-parser-test PRIVATE
    "SHELL:--embed-file '${LLAMA_CPP_DIR}/models/templates/Mistral-Small-3.2-24B-Instruct-2506.jinja@/mistral.jinja'"
    "SHELL:--embed-file '${LLAMA_CPP_DIR}/models/templates/Qwen-Qwen3-0.6B.jinja@/qwen3.jinja'")
  target_link_options(wfloat-llama-parser-test PRIVATE -O1 -fexceptions "SHELL:-s STACK_SIZE=8388608" "SHELL:-s DISABLE_EXCEPTION_CATCHING=0" "SHELL:-s ENVIRONMENT=node" "SHELL:-s ALLOW_MEMORY_GROWTH=1")
endif()
