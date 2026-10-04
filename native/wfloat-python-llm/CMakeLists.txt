cmake_minimum_required(VERSION 3.18)
project(wfloat-python-llm LANGUAGES C CXX)
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_POSITION_INDEPENDENT_CODE ON)
get_filename_component(WFLOAT_ROOT "${CMAKE_CURRENT_SOURCE_DIR}/../.." ABSOLUTE)
# Standalone build, or add_subdirectory after a llama-common-enabled llama build.
if(TARGET llama AND NOT TARGET llama-common)
  message(FATAL_ERROR
    "wfloat-python-llm requires llama-common. Set LLAMA_BUILD_COMMON=ON before adding llama.cpp.")
elseif(NOT TARGET llama)
  set(LLAMA_BUILD_COMMON ON CACHE BOOL "" FORCE)
  foreach(name TESTS TOOLS EXAMPLES SERVER APP UI HTML)
    set(LLAMA_BUILD_${name} OFF CACHE BOOL "" FORCE)
  endforeach()
  set(LLAMA_OPENSSL OFF CACHE BOOL "" FORCE)
  set(LLAMA_SUBPROCESS OFF CACHE BOOL "" FORCE)
  add_subdirectory("${WFLOAT_ROOT}/vendor/llama.cpp" "${CMAKE_CURRENT_BINARY_DIR}/llama")
endif()
add_library(wfloat-python-llm SHARED bridge.cpp
  "${WFLOAT_ROOT}/packages/react-native-wfloat/cpp/LlmRuntime.cpp"
  "${WFLOAT_ROOT}/native/wfloat-core/src/schema/validator.cc")
target_include_directories(wfloat-python-llm PRIVATE
  "${WFLOAT_ROOT}/vendor/llama.cpp/vendor"
  "${WFLOAT_ROOT}/native/wfloat-core/src")
target_link_libraries(wfloat-python-llm PRIVATE llama llama-common)
# Wheels copy the built libraries together rather than running cmake --install.
if(APPLE)
  set_target_properties(wfloat-python-llm PROPERTIES
    BUILD_RPATH "@loader_path" INSTALL_RPATH "@loader_path")
elseif(UNIX)
  set_target_properties(wfloat-python-llm PROPERTIES
    BUILD_RPATH "$ORIGIN" INSTALL_RPATH "$ORIGIN")
endif()
install(TARGETS wfloat-python-llm LIBRARY DESTINATION wfloat/native RUNTIME DESTINATION wfloat/native)
