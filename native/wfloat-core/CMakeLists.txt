cmake_minimum_required(VERSION 3.18)

set(WFLOAT_CORE_PUBLIC_HEADERS
    include/wfloat-core/wfloat_tts.h
)

set(WFLOAT_CORE_SOURCES
    src/wfloat_tts.cc
)

add_library(wfloat-core STATIC
    ${WFLOAT_CORE_PUBLIC_HEADERS}
    ${WFLOAT_CORE_SOURCES}
)

add_library(wfloat-core-shared SHARED
    ${WFLOAT_CORE_PUBLIC_HEADERS}
    ${WFLOAT_CORE_SOURCES}
)

target_compile_features(wfloat-core PUBLIC cxx_std_17)
target_compile_features(wfloat-core-shared PUBLIC cxx_std_17)

target_include_directories(wfloat-core
    PUBLIC
        ${CMAKE_CURRENT_SOURCE_DIR}/include
    PRIVATE
        ${PROJECT_SOURCE_DIR}/vendor/sherpa-onnx
)

target_include_directories(wfloat-core-shared
    PUBLIC
        ${CMAKE_CURRENT_SOURCE_DIR}/include
    PRIVATE
        ${PROJECT_SOURCE_DIR}/vendor/sherpa-onnx
)

target_link_libraries(wfloat-core
    PUBLIC
        sherpa-onnx-core
)

target_link_libraries(wfloat-core-shared
    PUBLIC
        sherpa-onnx-core
)

set_target_properties(wfloat-core PROPERTIES
    POSITION_INDEPENDENT_CODE ON
)

set_target_properties(wfloat-core-shared PROPERTIES
    POSITION_INDEPENDENT_CODE ON
    OUTPUT_NAME wfloat-core
)
