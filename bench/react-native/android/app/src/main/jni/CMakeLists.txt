cmake_minimum_required(VERSION 3.13)
project(appmodules)
include(${REACT_ANDROID_DIR}/cmake-utils/ReactNative-application.cmake)

add_library(bench_cpu SHARED BenchCpu.cpp)
target_compile_features(bench_cpu PRIVATE cxx_std_17)
target_compile_options(bench_cpu PRIVATE -O3 -fexceptions -Wall -Wextra)
target_include_directories(bench_cpu PRIVATE ../../../../../cpp)
target_link_libraries(bench_cpu EGL GLESv3)

add_library(bench_memory SHARED BenchMemory.cpp)
target_compile_features(bench_memory PRIVATE cxx_std_17)
target_compile_options(bench_memory PRIVATE -O2 -fexceptions -Wall -Wextra)
target_include_directories(bench_memory PRIVATE ../../../../../cpp)
target_link_libraries(bench_memory dl)

add_library(bench_faults SHARED BenchPageFaults.cpp)
target_compile_features(bench_faults PRIVATE cxx_std_17)
target_compile_options(bench_faults PRIVATE -O2 -fexceptions -Wall -Wextra)
target_include_directories(bench_faults PRIVATE ../../../../../cpp)

add_library(bench_process_cpu SHARED BenchProcessCpu.cpp)
target_compile_features(bench_process_cpu PRIVATE cxx_std_17)
target_compile_options(bench_process_cpu PRIVATE -O2 -fexceptions -Wall -Wextra)
target_include_directories(bench_process_cpu PRIVATE ../../../../../cpp)

add_library(bench_context_switches SHARED BenchContextSwitches.cpp)
target_compile_features(bench_context_switches PRIVATE cxx_std_17)
target_compile_options(bench_context_switches PRIVATE -O2 -fexceptions -Wall -Wextra)
target_include_directories(bench_context_switches PRIVATE ../../../../../cpp)

add_library(bench_storage_io SHARED BenchStorageIo.cpp)
target_compile_features(bench_storage_io PRIVATE cxx_std_17)
target_compile_options(bench_storage_io PRIVATE -O2 -fexceptions -Wall -Wextra)
target_include_directories(bench_storage_io PRIVATE ../../../../../cpp)

add_library(bench_file_descriptors SHARED BenchFileDescriptors.cpp)
target_compile_features(bench_file_descriptors PRIVATE cxx_std_17)
target_compile_options(bench_file_descriptors PRIVATE -O2 -fexceptions -Wall -Wextra)
target_include_directories(bench_file_descriptors PRIVATE ../../../../../cpp)

add_library(bench_thread_affinity SHARED BenchThreadAffinity.cpp)
target_compile_features(bench_thread_affinity PRIVATE cxx_std_17)
target_compile_options(bench_thread_affinity PRIVATE -O2 -Wall -Wextra)

add_library(bench_signals SHARED BenchSignals.cpp)
target_compile_features(bench_signals PRIVATE cxx_std_17)
target_compile_options(bench_signals PRIVATE -O2 -fexceptions -Wall -Wextra)

target_link_libraries(bench_signals vulkan EGL GLESv3)
