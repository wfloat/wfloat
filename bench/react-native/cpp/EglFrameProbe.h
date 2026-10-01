#pragma once
#include "NativeJson.h"
#include <EGL/egl.h>
#include <EGL/eglext.h>
#include <GLES2/gl2.h>
#include <android/native_window.h>
#include <chrono>
#include <cstring>
#include <thread>

namespace bench {
inline const char *eglTimestampState(EGLnsecsANDROID value) {
  if (value == EGL_TIMESTAMP_PENDING_ANDROID) return "pending";
  if (value == EGL_TIMESTAMP_INVALID_ANDROID) return "invalid";
  return "native_value"; // Zero is valid for composition without GPU rendering.
}
// Explicit owned window; never touches the app renderer's context or enables
// global timing. Driver calls themselves cannot be preempted by this deadline.
inline std::string eglFrameProbe(ANativeWindow *window) {
  if (!window) return jsonObject({{"error", jsonString("native window unavailable")}});
  struct Context {
    EGLDisplay display = EGL_NO_DISPLAY, previousDisplay = eglGetCurrentDisplay();
    EGLContext context = EGL_NO_CONTEXT, previousContext = eglGetCurrentContext();
    EGLSurface surface = EGL_NO_SURFACE, previousDraw = eglGetCurrentSurface(EGL_DRAW), previousRead = eglGetCurrentSurface(EGL_READ);
    EGLenum previousApi = eglQueryAPI();
    ~Context() {
      if (display != EGL_NO_DISPLAY) {
        if (context != EGL_NO_CONTEXT && eglGetCurrentContext() == context) eglMakeCurrent(display, EGL_NO_SURFACE, EGL_NO_SURFACE, EGL_NO_CONTEXT);
        if (context != EGL_NO_CONTEXT) eglDestroyContext(display, context);
        if (surface != EGL_NO_SURFACE) eglDestroySurface(display, surface);
      }
      eglBindAPI(previousApi);
      if (previousContext != EGL_NO_CONTEXT) eglMakeCurrent(previousDisplay, previousDraw, previousRead, previousContext);
      // EGLDisplay is process-shared: no eglTerminate.
    }
  } c;
  const auto fail = [](const char *operation) { const auto error = eglGetError(); return jsonObject({{"error", jsonString(operation)}, {"eglError", jsonInteger(error)}}); };
  c.display = eglGetDisplay(EGL_DEFAULT_DISPLAY);
  EGLint major = 0, minor = 0;
  if (c.display == EGL_NO_DISPLAY || !eglInitialize(c.display, &major, &minor)) return fail("eglInitialize");
  const char *extensions = eglQueryString(c.display, EGL_EXTENSIONS);
  const std::string list = std::string(" ") + (extensions ? extensions : "") + " ";
  if (list.find(" EGL_ANDROID_get_frame_timestamps ") == std::string::npos)
    return jsonObject({{"state", jsonString("extension_not_advertised")}, {"eglExtensions", jsonString(extensions ? extensions : "")}});
  auto nextFrame = reinterpret_cast<PFNEGLGETNEXTFRAMEIDANDROIDPROC>(eglGetProcAddress("eglGetNextFrameIdANDROID"));
  auto timingSupported = reinterpret_cast<PFNEGLGETCOMPOSITORTIMINGSUPPORTEDANDROIDPROC>(eglGetProcAddress("eglGetCompositorTimingSupportedANDROID"));
  auto timing = reinterpret_cast<PFNEGLGETCOMPOSITORTIMINGANDROIDPROC>(eglGetProcAddress("eglGetCompositorTimingANDROID"));
  auto supported = reinterpret_cast<PFNEGLGETFRAMETIMESTAMPSUPPORTEDANDROIDPROC>(eglGetProcAddress("eglGetFrameTimestampSupportedANDROID"));
  auto timestamps = reinterpret_cast<PFNEGLGETFRAMETIMESTAMPSANDROIDPROC>(eglGetProcAddress("eglGetFrameTimestampsANDROID"));
  if (!nextFrame || !timingSupported || !timing || !supported || !timestamps)
    return jsonObject({{"error", jsonString("advertised EGL timestamp functions unavailable")}});
  if (!eglBindAPI(EGL_OPENGL_ES_API)) return fail("eglBindAPI");
  const EGLint attrs[] = {EGL_SURFACE_TYPE, EGL_WINDOW_BIT, EGL_RENDERABLE_TYPE, EGL_OPENGL_ES2_BIT,
    EGL_RED_SIZE, 8, EGL_GREEN_SIZE, 8, EGL_BLUE_SIZE, 8, EGL_NONE};
  EGLConfig config{}; EGLint count = 0;
  if (!eglChooseConfig(c.display, attrs, &config, 1, &count) || count != 1) return fail("eglChooseConfig");
  EGLint format = 0;
  if (!eglGetConfigAttrib(c.display, config, EGL_NATIVE_VISUAL_ID, &format)) return fail("eglGetConfigAttrib");
  const int geometryError = ANativeWindow_setBuffersGeometry(window, 2, 2, format);
  if (geometryError) return jsonObject({{"error",jsonString("owned_window_geometry")},{"nativeReturnCode",std::to_string(geometryError)}});
  c.surface = eglCreateWindowSurface(c.display, config, window, nullptr);
  if (c.surface == EGL_NO_SURFACE) return fail("eglCreateWindowSurface");
  const EGLint contextAttrs[] = {EGL_CONTEXT_CLIENT_VERSION, 2, EGL_NONE};
  c.context = eglCreateContext(c.display, config, EGL_NO_CONTEXT, contextAttrs);
  if (c.context == EGL_NO_CONTEXT || !eglMakeCurrent(c.display, c.surface, c.surface, c.context)) return fail("eglMakeCurrent");
  if (!eglSurfaceAttrib(c.display, c.surface, EGL_TIMESTAMPS_ANDROID, EGL_TRUE)) return fail("enable_owned_surface_timestamps");
  struct Field { EGLint key; const char *name; };
  const Field compositor[] = {{EGL_COMPOSITE_DEADLINE_ANDROID,"COMPOSITE_DEADLINE"},
    {EGL_COMPOSITE_INTERVAL_ANDROID,"COMPOSITE_INTERVAL"}, {EGL_COMPOSITE_TO_PRESENT_LATENCY_ANDROID,"COMPOSITE_TO_PRESENT_LATENCY"}};
  std::string predictions = "[";
  for (const auto &field : compositor) {
    eglGetError(); const bool available = timingSupported(c.display, c.surface, field.key) == EGL_TRUE; const auto supportError = eglGetError();
    EGLnsecsANDROID value = 0; const bool ok = available && supportError == EGL_SUCCESS && timing(c.display,c.surface,1,&field.key,&value) == EGL_TRUE;
    const auto error = eglGetError();
    if (predictions.size() > 1) predictions += ',';
    predictions += jsonObject({{"name",jsonString(field.name)}, {"supported",available?"true":"false"},
      {"supportError",jsonInteger(supportError)}, {"queryError",jsonInteger(error)}, {"querySucceeded",ok?"true":"false"}, {"nanoseconds",ok?jsonInteger(value):"null"}});
  }
  const Field fields[] = {{EGL_REQUESTED_PRESENT_TIME_ANDROID,"REQUESTED_PRESENT_TIME"},
    {EGL_RENDERING_COMPLETE_TIME_ANDROID,"RENDERING_COMPLETE_TIME"}, {EGL_COMPOSITION_LATCH_TIME_ANDROID,"COMPOSITION_LATCH_TIME"},
    {EGL_FIRST_COMPOSITION_START_TIME_ANDROID,"FIRST_COMPOSITION_START_TIME"}, {EGL_LAST_COMPOSITION_START_TIME_ANDROID,"LAST_COMPOSITION_START_TIME"},
    {EGL_FIRST_COMPOSITION_GPU_FINISHED_TIME_ANDROID,"FIRST_COMPOSITION_GPU_FINISHED_TIME"}, {EGL_DISPLAY_PRESENT_TIME_ANDROID,"DISPLAY_PRESENT_TIME"},
    {EGL_DEQUEUE_READY_TIME_ANDROID,"DEQUEUE_READY_TIME"}, {EGL_READS_DONE_TIME_ANDROID,"READS_DONE_TIME"}};
  bool available[9]{}; EGLint supportErrors[9]{};
  for (size_t i=0;i<9;++i) { eglGetError();available[i]=supported(c.display,c.surface,fields[i].key)==EGL_TRUE;supportErrors[i]=eglGetError(); }
  EGLuint64KHR frame = 0;
  if (!nextFrame(c.display,c.surface,&frame)) return fail("eglGetNextFrameIdANDROID");
  glViewport(0,0,2,2);glClearColor(.12f,.35f,.3f,1.f);glClear(GL_COLOR_BUFFER_BIT);
  const auto glError = glGetError();
  if (!eglSwapBuffers(c.display,c.surface)) return fail("eglSwapBuffers");
  const auto began=std::chrono::steady_clock::now();
  const auto sample = [&]() {
    std::string rows="[";
    for(size_t i=0;i<9;++i) {
      EGLnsecsANDROID value=0;eglGetError();
      const bool ok=available[i] && supportErrors[i]==EGL_SUCCESS && timestamps(c.display,c.surface,frame,1,&fields[i].key,&value)==EGL_TRUE;
      const auto error=eglGetError();if(i)rows+=',';
      rows+=jsonObject({{"name",jsonString(fields[i].name)}, {"supported",available[i]?"true":"false"},
        {"supportError",jsonInteger(supportErrors[i])}, {"querySucceeded",ok?"true":"false"}, {"queryError",jsonInteger(error)},
        {"nanoseconds",ok?jsonInteger(value):"null"}, {"state",jsonString(ok?eglTimestampState(value):"unavailable")}});
    }
    return jsonObject({{"elapsedSinceSwapNs",jsonInteger(std::chrono::duration_cast<std::chrono::nanoseconds>(std::chrono::steady_clock::now()-began).count())}, {"timestamps",rows+']'}});
  };
  const auto immediate=sample();
  // Only two snapshots, not a busy polling loop. Reuse timestamps can remain
  // pending while this final frame is still displayed; preserve that fact.
  std::this_thread::sleep_for(std::chrono::milliseconds(250));
  const auto delayed=sample();
  return jsonObject({{"state",jsonString("completed")}, {"frameId",jsonInteger(frame)}, {"glError",jsonInteger(glError)},
    {"compositorPredictions",predictions+']'}, {"immediate",immediate}, {"delayed",delayed},
    {"scope",jsonString("one owned 2x2 EGL window frame; native monotonic nanoseconds, pending=-2, invalid=-1; compositor predictions are not actual timings; GPU-finished zero can mean hardware composition; no timestamp substitution")}});
}
}
