cmake_minimum_required(VERSION 3.18)

set(WFLOAT_CORE_PUBLIC_HEADERS
    include/wfloat-core/wfloat_common.h
    include/wfloat-core/wfloat_llm.h
)

set(WFLOAT_CORE_SOURCES
    src/wfloat_llm.cc
)

if(WFLOAT_CORE_ENABLE_SPEECH)
    list(APPEND WFLOAT_CORE_PUBLIC_HEADERS
        include/wfloat-core/wfloat_stt.h
        include/wfloat-core/wfloat_tts.h
        include/wfloat-core/wfloat_vad.h
    )
    list(APPEND WFLOAT_CORE_SOURCES
        src/wfloat_stt.cc
        src/wfloat_tts.cc
        src/wfloat_vad.cc
    )
endif()

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
)

target_include_directories(wfloat-core-shared
    PUBLIC
        ${CMAKE_CURRENT_SOURCE_DIR}/include
)

if(WFLOAT_CORE_ENABLE_SPEECH)
    target_include_directories(wfloat-core
        PRIVATE
            ${PROJECT_SOURCE_DIR}/vendor/sherpa-onnx
    )

    target_include_directories(wfloat-core-shared
        PRIVATE
            ${PROJECT_SOURCE_DIR}/vendor/sherpa-onnx
    )

    target_link_libraries(wfloat-core
        PUBLIC
            sherpa-onnx-c-api
    )

    target_link_libraries(wfloat-core-shared
        PUBLIC
            sherpa-onnx-c-api
    )
endif()

if(WFLOAT_ENABLE_LLAMA_CPP)
    target_compile_definitions(wfloat-core PRIVATE WFLOAT_ENABLE_LLAMA_CPP=1)
    target_compile_definitions(wfloat-core-shared PRIVATE WFLOAT_ENABLE_LLAMA_CPP=1)

    target_link_libraries(wfloat-core
        PUBLIC
            llama
    )

    target_link_libraries(wfloat-core-shared
        PUBLIC
            llama
    )
endif()

set_target_properties(wfloat-core PROPERTIES
    POSITION_INDEPENDENT_CODE ON
)

set_target_properties(wfloat-core-shared PROPERTIES
    POSITION_INDEPENDENT_CODE ON
    OUTPUT_NAME wfloat-core
)

if(APPLE)
    set_target_properties(wfloat-core-shared PROPERTIES
        BUILD_RPATH "@loader_path"
        INSTALL_RPATH "@loader_path"
    )
elseif(UNIX)
    set_target_properties(wfloat-core-shared PROPERTIES
        BUILD_RPATH "$ORIGIN"
        INSTALL_RPATH "$ORIGIN"
    )
endif()
