cmake_minimum_required(VERSION 3.16)
project(niimblue VERSION 0.1.0 LANGUAGES C)

# libniimblue: niimbluelib (JavaScript) + QuickJS-ng compiled into one native
# library with a C API (include/niimblue.h).
#
# Outputs:
#   niimblue_shared -> libniimblue.so / libniimblue.dylib / niimblue.dll
#   niimblue_static -> libniimblue.a / niimblue_static.lib  (self-contained, for Go/Rust static linking)
#   niimblue_jni    -> libniimblue_jni.so / .dylib / niimblue_jni.dll (NIIM_BUILD_JNI, Kotlin/Java bindings)
#
# Only a C compiler is needed: the JS bundle is pre-generated in
# generated/niim_bundle.c (regenerate with `npm run bundle`).
#
# Use from another CMake project:
#   find_package(niimblue CONFIG REQUIRED)        # after `cmake --install`
#   add_subdirectory(path/to/native) / FetchContent
#   target_link_libraries(app PRIVATE niimblue::niimblue)   # or niimblue::static
# or with pkg-config: `pkg-config --cflags --libs niimblue`.

if(CMAKE_SOURCE_DIR STREQUAL CMAKE_CURRENT_SOURCE_DIR)
  set(NIIM_TOP_LEVEL ON)
else()
  set(NIIM_TOP_LEVEL OFF)
endif()

option(NIIM_BUILD_SHARED "Build the shared library" ON)
option(NIIM_BUILD_STATIC "Build the static library" ON)
option(NIIM_BUILD_TESTS "Build the C test program" ${NIIM_TOP_LEVEL})
option(NIIM_BUILD_JNI "Build the JNI library for the Kotlin/Java bindings" OFF)
option(NIIM_INSTALL "Generate install rules (headers, libraries, CMake package, pkg-config)" ${NIIM_TOP_LEVEL})

include(GNUInstallDirs)
set(NIIM_INCLUDE_DIRS
  $<BUILD_INTERFACE:${CMAKE_CURRENT_SOURCE_DIR}/include>
  $<INSTALL_INTERFACE:${CMAKE_INSTALL_INCLUDEDIR}>
)

set(CMAKE_C_STANDARD 11)
set(CMAKE_C_STANDARD_REQUIRED ON)
set(CMAKE_POSITION_INDEPENDENT_CODE ON)
set(CMAKE_C_VISIBILITY_PRESET hidden)

if(NOT CMAKE_BUILD_TYPE AND NOT CMAKE_CONFIGURATION_TYPES)
  set(CMAKE_BUILD_TYPE Release)
endif()

set(QJS_DIR ${CMAKE_CURRENT_SOURCE_DIR}/third_party/quickjs)
if(NOT EXISTS ${QJS_DIR}/quickjs.c)
  message(FATAL_ERROR "QuickJS-ng sources missing in ${QJS_DIR} (vendored copy, see third_party/quickjs/VERSION)")
endif()

find_package(Threads REQUIRED)

# ---- QuickJS-ng (compiled in, symbols hidden) ----
add_library(niim_qjs OBJECT
  ${QJS_DIR}/dtoa.c
  ${QJS_DIR}/libregexp.c
  ${QJS_DIR}/libunicode.c
  ${QJS_DIR}/quickjs.c
)
target_include_directories(niim_qjs PUBLIC ${QJS_DIR})
target_compile_definitions(niim_qjs PRIVATE _GNU_SOURCE QUICKJS_NG_BUILD)
if(WIN32)
  target_compile_definitions(niim_qjs PRIVATE WIN32_LEAN_AND_MEAN _WIN32_WINNT=0x0601)
endif()
if(MSVC)
  target_compile_options(niim_qjs PRIVATE /W0)
else()
  target_compile_options(niim_qjs PRIVATE -w)
endif()

# ---- libniimblue ----
add_library(niim_core OBJECT
  src/niimblue.c
  src/serial.c
  generated/niim_bundle.c
)
target_include_directories(niim_core
  PUBLIC ${CMAKE_CURRENT_SOURCE_DIR}/include
  PRIVATE ${QJS_DIR}
)
target_compile_definitions(niim_core PRIVATE QUICKJS_NG_BUILD)
if(MSVC)
  target_compile_options(niim_core PRIVATE /W4)
else()
  target_compile_options(niim_core PRIVATE -Wall -Wextra -Wno-unused-parameter)
endif()

set(NIIM_LIBS Threads::Threads)
if(WIN32)
  # nothing extra: kernel32 is implicit
elseif(UNIX)
  list(APPEND NIIM_LIBS m ${CMAKE_DL_LIBS})
endif()

if(NIIM_BUILD_SHARED)
  add_library(niimblue_shared SHARED $<TARGET_OBJECTS:niim_core> $<TARGET_OBJECTS:niim_qjs>)
  set_target_properties(niimblue_shared PROPERTIES OUTPUT_NAME niimblue VERSION ${PROJECT_VERSION} SOVERSION 0 EXPORT_NAME shared)
  target_include_directories(niimblue_shared PUBLIC ${NIIM_INCLUDE_DIRS})
  target_link_libraries(niimblue_shared PRIVATE ${NIIM_LIBS})
  if(MINGW)
    # Fully self-contained DLL (no libgcc / winpthread DLL dependencies)
    target_link_options(niimblue_shared PRIVATE -static -static-libgcc)
  endif()
  add_library(niimblue::shared ALIAS niimblue_shared)
endif()

if(NIIM_BUILD_STATIC)
  add_library(niimblue_static STATIC $<TARGET_OBJECTS:niim_core> $<TARGET_OBJECTS:niim_qjs>)
  if(MSVC)
    set_target_properties(niimblue_static PROPERTIES OUTPUT_NAME niimblue_static)
  else()
    set_target_properties(niimblue_static PROPERTIES OUTPUT_NAME niimblue)
  endif()
  set_target_properties(niimblue_static PROPERTIES EXPORT_NAME static)
  target_include_directories(niimblue_static PUBLIC ${NIIM_INCLUDE_DIRS})
  target_compile_definitions(niimblue_static INTERFACE NIIM_STATIC)
  target_link_libraries(niimblue_static INTERFACE ${NIIM_LIBS})
  add_library(niimblue::static ALIAS niimblue_static)
endif()

# niimblue::niimblue: the shared library if built, else the static one
if(TARGET niimblue_shared)
  add_library(niimblue::niimblue ALIAS niimblue_shared)
elseif(TARGET niimblue_static)
  add_library(niimblue::niimblue ALIAS niimblue_static)
endif()

# ---- JNI library (Kotlin/Java bindings, bindings/jni) ----
# Desktop: needs a JDK (JAVA_HOME). Android: built by the Gradle module
# bindings/kotlin/niimblue-android-native through the NDK.
if(NIIM_BUILD_JNI)
  add_library(niimblue_jni SHARED
    $<TARGET_OBJECTS:niim_core> $<TARGET_OBJECTS:niim_qjs>
    bindings/jni/niimblue_jni.c
  )
  target_include_directories(niimblue_jni PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/include ${CMAKE_CURRENT_SOURCE_DIR}/src)
  if(NOT ANDROID)
    find_package(JNI REQUIRED)
    target_include_directories(niimblue_jni PRIVATE ${JNI_INCLUDE_DIRS})
  endif()
  target_link_libraries(niimblue_jni PRIVATE ${NIIM_LIBS})
  if(MSVC)
    target_compile_options(niimblue_jni PRIVATE /W4)
  else()
    target_compile_options(niimblue_jni PRIVATE -Wall -Wextra -Wno-unused-parameter)
  endif()
  if(ANDROID)
    # 16 KB page size devices (Android 15+)
    target_link_options(niimblue_jni PRIVATE "-Wl,-z,max-page-size=16384")
  endif()
  if(MINGW)
    target_link_options(niimblue_jni PRIVATE -static -static-libgcc)
  endif()
endif()

if(NIIM_BUILD_TESTS AND NIIM_BUILD_STATIC)
  add_executable(niim_test test/test.c)
  target_link_libraries(niim_test PRIVATE niimblue_static)
  add_executable(niim_cli examples/c/cli.c)
  target_link_libraries(niim_cli PRIVATE niimblue_static)
endif()

# ---- Python wheel (pyproject.toml, scikit-build-core) ----
# Only the shared library goes into the wheel, next to the ctypes package.
if(SKBUILD)
  if(NOT TARGET niimblue_shared)
    message(FATAL_ERROR "the Python package needs NIIM_BUILD_SHARED=ON")
  endif()
  install(FILES $<TARGET_FILE:niimblue_shared> DESTINATION niimblue)
  return()
endif()

# ---- install: headers, libraries, CMake package, pkg-config ----
if(NIIM_INSTALL)
  include(CMakePackageConfigHelpers)
  set(NIIM_CMAKE_DIR ${CMAKE_INSTALL_LIBDIR}/cmake/niimblue)

  install(FILES include/niimblue.h DESTINATION ${CMAKE_INSTALL_INCLUDEDIR})
  set(NIIM_INSTALL_TARGETS)
  if(TARGET niimblue_shared)
    list(APPEND NIIM_INSTALL_TARGETS niimblue_shared)
  endif()
  if(TARGET niimblue_static)
    list(APPEND NIIM_INSTALL_TARGETS niimblue_static)
  endif()
  install(TARGETS ${NIIM_INSTALL_TARGETS} EXPORT niimblueTargets
    ARCHIVE DESTINATION ${CMAKE_INSTALL_LIBDIR}
    LIBRARY DESTINATION ${CMAKE_INSTALL_LIBDIR}
    RUNTIME DESTINATION ${CMAKE_INSTALL_BINDIR}
    INCLUDES DESTINATION ${CMAKE_INSTALL_INCLUDEDIR}
  )
  if(TARGET niimblue_jni)
    install(TARGETS niimblue_jni LIBRARY DESTINATION ${CMAKE_INSTALL_LIBDIR} RUNTIME DESTINATION ${CMAKE_INSTALL_BINDIR})
  endif()
  install(EXPORT niimblueTargets NAMESPACE niimblue:: DESTINATION ${NIIM_CMAKE_DIR})

  configure_package_config_file(cmake/niimblueConfig.cmake.in
    ${CMAKE_CURRENT_BINARY_DIR}/niimblueConfig.cmake
    INSTALL_DESTINATION ${NIIM_CMAKE_DIR}
  )
  write_basic_package_version_file(${CMAKE_CURRENT_BINARY_DIR}/niimblueConfigVersion.cmake
    COMPATIBILITY SameMinorVersion
  )
  install(FILES
    ${CMAKE_CURRENT_BINARY_DIR}/niimblueConfig.cmake
    ${CMAKE_CURRENT_BINARY_DIR}/niimblueConfigVersion.cmake
    DESTINATION ${NIIM_CMAKE_DIR}
  )

  # pkg-config: `niimblue` (shared if installed, else static; --static adds the system libs)
  set(NIIM_PC_PRIVATE_LIBS "")
  if(UNIX)
    set(NIIM_PC_PRIVATE_LIBS "-lpthread -lm")
    if(CMAKE_DL_LIBS)
      string(APPEND NIIM_PC_PRIVATE_LIBS " -l${CMAKE_DL_LIBS}")
    endif()
  endif()
  if(TARGET niimblue_shared)
    set(NIIM_PC_CFLAGS "")
  else()
    set(NIIM_PC_CFLAGS " -DNIIM_STATIC")
  endif()
  if(MSVC AND NOT TARGET niimblue_shared)
    set(NIIM_PC_LIBNAME niimblue_static)
  else()
    set(NIIM_PC_LIBNAME niimblue)
  endif()
  configure_file(cmake/niimblue.pc.in ${CMAKE_CURRENT_BINARY_DIR}/niimblue.pc @ONLY)
  install(FILES ${CMAKE_CURRENT_BINARY_DIR}/niimblue.pc DESTINATION ${CMAKE_INSTALL_LIBDIR}/pkgconfig)
endif()
