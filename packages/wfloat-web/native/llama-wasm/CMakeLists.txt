cmake_minimum_required(VERSION 3.14)

project(wfloat-llama-wasm C CXX)

if (NOT EMSCRIPTEN)
  message(FATAL_ERROR "wfloat-llama-wasm must be built with Emscripten. Use emcmake cmake.")
endif()

set(LLAMA_CPP_DIR "${CMAKE_CURRENT_SOURCE_DIR}/../../../../vendor/llama.cpp" CACHE PATH "Path to vendored llama.cpp")

set(BUILD_SHARED_LIBS OFF CACHE BOOL "" FORCE)
set(LLAMA_BUILD_COMMON OFF CACHE BOOL "" FORCE)
set(LLAMA_BUILD_TESTS OFF CACHE BOOL "" FORCE)
set(LLAMA_BUILD_TOOLS OFF CACHE BOOL "" FORCE)
set(LLAMA_BUILD_EXAMPLES OFF CACHE BOOL "" FORCE)
set(LLAMA_BUILD_SERVER OFF CACHE BOOL "" FORCE)
set(LLAMA_BUILD_APP OFF CACHE BOOL "" FORCE)
set(LLAMA_BUILD_UI OFF CACHE BOOL "" FORCE)
set(LLAMA_USE_PREBUILT_UI OFF CACHE BOOL "" FORCE)
set(LLAMA_BUILD_HTML OFF CACHE BOOL "" FORCE)
set(LLAMA_WASM_MEM64 OFF CACHE BOOL "" FORCE)
set(GGML_OPENMP OFF CACHE BOOL "" FORCE)
set(GGML_NATIVE OFF CACHE BOOL "" FORCE)

add_subdirectory("${LLAMA_CPP_DIR}" "${CMAKE_BINARY_DIR}/llama.cpp")

set(CMAKE_RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}")

add_executable(wfloat-llama-wasm llama_wasm.cpp)
set_target_properties(wfloat-llama-wasm PROPERTIES SUFFIX ".js")
target_compile_features(wfloat-llama-wasm PRIVATE cxx_std_17)
target_compile_options(wfloat-llama-wasm PRIVATE -fexceptions)
target_link_libraries(wfloat-llama-wasm PRIVATE llama)

target_link_options(wfloat-llama-wasm PRIVATE
  "SHELL:-fexceptions"
  "SHELL:-s DISABLE_EXCEPTION_CATCHING=0"
  "SHELL:-s MODULARIZE=1"
  "SHELL:-s EXPORT_ES6=1"
  "SHELL:-s ENVIRONMENT=web,worker"
  "SHELL:-s ALLOW_MEMORY_GROWTH=1"
  "SHELL:-s INITIAL_MEMORY=268435456"
  "SHELL:-s FILESYSTEM=1"
  "SHELL:-s NO_EXIT_RUNTIME=1"
  "SHELL:-s ALLOW_TABLE_GROWTH=1"
  "SHELL:-s EXPORTED_RUNTIME_METHODS=['ccall','cwrap','FS','UTF8ToString','stringToUTF8','lengthBytesUTF8','setValue','getValue','addFunction','removeFunction']"
  "SHELL:-s EXPORTED_FUNCTIONS=['_malloc','_free','_wfloat_llama_model_create','_wfloat_llama_model_destroy','_wfloat_llama_model_generate_json','_wfloat_llama_model_format_chat','_wfloat_llama_free_string','_wfloat_llama_last_error']"
)
