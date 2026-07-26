cmake_minimum_required(VERSION 3.20)
project(vsthost CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")

if(NOT NODE_ADDON_API_DIR)
  execute_process(COMMAND node -p "require('node-addon-api').include_dir"
    WORKING_DIRECTORY ${CMAKE_SOURCE_DIR}
    OUTPUT_VARIABLE NODE_ADDON_API_DIR OUTPUT_STRIP_TRAILING_WHITESPACE)
endif()

set(SDK ${CMAKE_SOURCE_DIR}/sdk)

# Minimal hosting subset of the VST3 SDK — compiled directly into the addon
# rather than via the SDK's own CMake superproject.
set(SDK_SOURCES
  ${SDK}/public.sdk/source/vst/hosting/module.cpp
  ${SDK}/public.sdk/source/vst/hosting/module_win32.cpp
  ${SDK}/public.sdk/source/vst/hosting/hostclasses.cpp
  ${SDK}/public.sdk/source/vst/hosting/pluginterfacesupport.cpp
  ${SDK}/public.sdk/source/vst/hosting/parameterchanges.cpp
  ${SDK}/public.sdk/source/vst/hosting/processdata.cpp
  ${SDK}/public.sdk/source/vst/hosting/eventlist.cpp
  ${SDK}/public.sdk/source/vst/hosting/plugprovider.cpp
  ${SDK}/public.sdk/source/vst/hosting/connectionproxy.cpp
  ${SDK}/public.sdk/source/vst/utility/stringconvert.cpp
  ${SDK}/public.sdk/source/vst/vstinitiids.cpp
  ${SDK}/public.sdk/source/common/memorystream.cpp
  ${SDK}/public.sdk/source/common/commoniids.cpp
  ${SDK}/public.sdk/source/common/commonstringconvert.cpp
  ${SDK}/public.sdk/source/common/threadchecker_win32.cpp
  ${SDK}/pluginterfaces/base/funknown.cpp
  ${SDK}/pluginterfaces/base/coreiids.cpp
  ${SDK}/pluginterfaces/base/ustring.cpp
  ${SDK}/pluginterfaces/base/conststringtable.cpp
  ${SDK}/base/source/baseiids.cpp
  ${SDK}/base/source/fobject.cpp
  ${SDK}/base/source/fstring.cpp
  ${SDK}/base/source/fbuffer.cpp
  ${SDK}/base/source/fdebug.cpp
  ${SDK}/base/source/fstreamer.cpp
  ${SDK}/base/source/updatehandler.cpp
  ${SDK}/base/thread/source/flock.cpp
)

# uithread.cc uses C++/WinRT (Windows.Graphics.Capture), which requires C++20
# on this toolset; the VST3 SDK sources break under C++20 (char8_t in
# module_win32.cpp). Split standards: UI thread in its own C++20 static lib.
add_library(vsthost_ui STATIC src/uithread.cc)
set_target_properties(vsthost_ui PROPERTIES CXX_STANDARD 20 CXX_STANDARD_REQUIRED ON)
target_include_directories(vsthost_ui PRIVATE ${SDK} ${CMAKE_SOURCE_DIR}/src)
target_compile_definitions(vsthost_ui PRIVATE UNICODE _UNICODE RELEASE=1)
if(MSVC)
  target_compile_options(vsthost_ui PRIVATE /EHsc /utf-8 /bigobj)
endif()

add_library(${PROJECT_NAME} SHARED
  src/addon.cc
  src/host.cc
  ${SDK_SOURCES}
  ${CMAKE_JS_SRC}
)
set_target_properties(${PROJECT_NAME} PROPERTIES PREFIX "" SUFFIX ".node")

target_include_directories(${PROJECT_NAME} PRIVATE
  ${CMAKE_JS_INC} ${NODE_ADDON_API_DIR} ${SDK})
target_link_libraries(${PROJECT_NAME} PRIVATE ${CMAKE_JS_LIB} vsthost_ui
  ole32 shell32 user32 advapi32 gdi32 dwmapi d3d11 dxgi windowsapp)

target_compile_definitions(${PROJECT_NAME} PRIVATE
  NAPI_VERSION=8
  NAPI_DISABLE_CPP_EXCEPTIONS
  NODE_ADDON_API_DISABLE_DEPRECATED
  UNICODE _UNICODE
  RELEASE=1
)
if(MSVC)
  target_compile_options(${PROJECT_NAME} PRIVATE /EHsc /utf-8)
endif()
