# Builds libvalhalla_jni.so: the thin JNI wrapper linked against the prebuilt
# static libvalhalla (+ protobuf-lite) cross-compiled out-of-band — see
# build.gradle for where VALHALLA_DEPS points and what lives under it.
cmake_minimum_required(VERSION 3.22)
project(valhalla_jni CXX)

if(NOT DEFINED VALHALLA_DEPS)
  message(FATAL_ERROR "VALHALLA_DEPS must point at the prebuilt valhalla deps root")
endif()

# Valhalla 3.8 headers use C++20 (std::format, std::ranges).
set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

set(VALHALLA_PREFIX ${VALHALLA_DEPS}/valhalla-${ANDROID_ABI})
set(PROTOBUF_PREFIX ${VALHALLA_DEPS}/android-${ANDROID_ABI})

add_library(valhalla_jni SHARED valhalla_jni.cpp)

target_include_directories(valhalla_jni PRIVATE
  ${VALHALLA_PREFIX}/include
  ${VALHALLA_PREFIX}/include/valhalla/third_party
  ${PROTOBUF_PREFIX}/include
  ${VALHALLA_DEPS}/boost_1_86_0
)

# Static libs first, then their downstream deps (libvalhalla.pc:
# Requires zlib protobuf-lite; NDK provides z and log).
target_link_libraries(valhalla_jni
  ${VALHALLA_PREFIX}/lib/libvalhalla.a
  ${PROTOBUF_PREFIX}/lib/libprotobuf-lite.a
  z
  log
)
