#pragma once

#include <EGL/egl.h>
#include <GLES3/gl31.h>
#include <atomic>
#include <cmath>
#include <mutex>
#include <stdexcept>
#include <string>
#include "CpuStress.h"

namespace bench {
struct GpuSnapshot {
  bool enabled = false, active = false;
  uint64_t batches = 0;
  double checksum = 0;
  int64_t lastBatchMs = 0;
  std::string renderer, error;
};

// Offscreen ES 3.1 compute: no animation, frame pacing, or unbounded queue.
// One dispatch is in flight at a time. Count only fence-completed dispatches
// whose first output matches the same arithmetic computed on the CPU.
class GpuStress {
  std::mutex mutex_;
  GpuSnapshot state_;
  struct Context {
    EGLDisplay display = EGL_NO_DISPLAY;
    EGLSurface surface = EGL_NO_SURFACE;
    EGLContext context = EGL_NO_CONTEXT;
    GLuint shader = 0, program = 0, buffer = 0;
    GLsync fence = nullptr;
    ~Context() {
      if (eglGetCurrentContext() == context && context != EGL_NO_CONTEXT) {
        if (fence) glDeleteSync(fence);
        if (buffer) glDeleteBuffers(1, &buffer);
        if (program) glDeleteProgram(program);
        if (shader) glDeleteShader(shader);
        eglMakeCurrent(display, EGL_NO_SURFACE, EGL_NO_SURFACE, EGL_NO_CONTEXT);
      }
      if (surface != EGL_NO_SURFACE) eglDestroySurface(display, surface);
      if (context != EGL_NO_CONTEXT) eglDestroyContext(display, context);
      // The default EGL display may also serve React Native; do not terminate it.
      eglReleaseThread();
    }
  };
  static void require(bool success, const std::string &reason) {
    if (!success) throw std::runtime_error(reason);
  }
  static void glCheck(const char *operation) {
    const auto error = glGetError();
    require(error == GL_NO_ERROR, std::string(operation) + " GL error " + std::to_string(error));
  }
  static constexpr int iterations = 512;
  static constexpr int invocations = 65536;
  static double expected(float seed) {
    double sum = 0;
    for (int chain = 0; chain < 8; ++chain) {
      for (int lane = 0; lane < 4; ++lane) {
        float value = seed + chain * .1f + lane * .02f;
        const float multiplier = .9999f - lane * .00001f;
        const float addend = .0001f + lane * .00001f;
        for (int i = 0; i < iterations; ++i) value = std::fma(value, multiplier, addend);
        sum += value;
      }
    }
    return sum;
  }

 public:
  void reset(bool enabled) {
    std::lock_guard<std::mutex> lock(mutex_);
    state_ = {};
    state_.enabled = enabled;
  }
  GpuSnapshot snapshot() {
    std::lock_guard<std::mutex> lock(mutex_);
    return state_;
  }
  void run(const std::atomic<bool> &stop) {
    try {
      Context gl;
      gl.display = eglGetDisplay(EGL_DEFAULT_DISPLAY);
      require(gl.display != EGL_NO_DISPLAY && eglInitialize(gl.display, nullptr, nullptr), "EGL initialization failed");
      require(eglBindAPI(EGL_OPENGL_ES_API), "EGL ES binding failed");
      const EGLint configAttrs[] = {EGL_SURFACE_TYPE, EGL_PBUFFER_BIT,
        EGL_RENDERABLE_TYPE, EGL_OPENGL_ES3_BIT, EGL_NONE};
      EGLConfig config;
      EGLint count = 0;
      require(eglChooseConfig(gl.display, configAttrs, &config, 1, &count) && count == 1, "No ES 3 EGL config");
      const EGLint contextAttrs[] = {EGL_CONTEXT_CLIENT_VERSION, 3, EGL_NONE};
      gl.context = eglCreateContext(gl.display, config, EGL_NO_CONTEXT, contextAttrs);
      require(gl.context != EGL_NO_CONTEXT, "ES context creation failed");
      const EGLint surfaceAttrs[] = {EGL_WIDTH, 1, EGL_HEIGHT, 1, EGL_NONE};
      gl.surface = eglCreatePbufferSurface(gl.display, config, surfaceAttrs);
      require(gl.surface != EGL_NO_SURFACE && eglMakeCurrent(gl.display, gl.surface, gl.surface, gl.context), "Offscreen context activation failed");
      GLint major = 0, minor = 0;
      glGetIntegerv(GL_MAJOR_VERSION, &major);
      glGetIntegerv(GL_MINOR_VERSION, &minor);
      require(major > 3 || (major == 3 && minor >= 1), "GPU stress requires OpenGL ES 3.1 compute");
      {
        std::lock_guard<std::mutex> lock(mutex_);
        const auto renderer = glGetString(GL_RENDERER);
        state_.renderer = renderer ? reinterpret_cast<const char*>(renderer) : "Unknown renderer";
      }
      const char *source = R"GLSL(#version 310 es
precision highp float;
precision highp int;
layout(local_size_x = 64) in;
layout(std430, binding = 0) writeonly buffer Output { vec4 values[]; };
uniform float seed;
uniform int iterations;
void main() {
  uint id = gl_GlobalInvocationID.x;
  vec4 base = vec4(seed + float(id % 127u) * 0.001) + vec4(0.0, 0.02, 0.04, 0.06);
  vec4 a = base, b = base + 0.1, c = base + 0.2, d = base + 0.3;
  vec4 e = base + 0.4, f = base + 0.5, g = base + 0.6, h = base + 0.7;
  vec4 m = vec4(0.9999, 0.99989, 0.99988, 0.99987);
  vec4 k = vec4(0.0001, 0.00011, 0.00012, 0.00013);
  for (int i = 0; i < iterations; ++i) {
    a = a * m + k; b = b * m + k;
    c = c * m + k; d = d * m + k;
    e = e * m + k; f = f * m + k;
    g = g * m + k; h = h * m + k;
  }
  values[id] = a + b + c + d + e + f + g + h;
}
)GLSL";
      gl.shader = glCreateShader(GL_COMPUTE_SHADER);
      glShaderSource(gl.shader, 1, &source, nullptr);
      glCompileShader(gl.shader);
      GLint okay = 0;
      glGetShaderiv(gl.shader, GL_COMPILE_STATUS, &okay);
      char log[2048] = {};
      if (!okay) glGetShaderInfoLog(gl.shader, sizeof(log), nullptr, log);
      require(okay, std::string("Compute shader compilation failed: ") + log);
      gl.program = glCreateProgram();
      glAttachShader(gl.program, gl.shader);
      glLinkProgram(gl.program);
      glGetProgramiv(gl.program, GL_LINK_STATUS, &okay);
      if (!okay) glGetProgramInfoLog(gl.program, sizeof(log), nullptr, log);
      require(okay, std::string("Compute program link failed: ") + log);
      glUseProgram(gl.program);
      const GLint seedLocation = glGetUniformLocation(gl.program, "seed");
      const GLint iterationsLocation = glGetUniformLocation(gl.program, "iterations");
      require(seedLocation >= 0 && iterationsLocation >= 0, "Missing compute uniforms");
      glUniform1i(iterationsLocation, iterations);
      glGenBuffers(1, &gl.buffer);
      glBindBuffer(GL_SHADER_STORAGE_BUFFER, gl.buffer);
      glBufferData(GL_SHADER_STORAGE_BUFFER, invocations * 4 * sizeof(float), nullptr, GL_DYNAMIC_READ);
      glBindBufferBase(GL_SHADER_STORAGE_BUFFER, 0, gl.buffer);
      glCheck("Compute setup");
      {
        std::lock_guard<std::mutex> lock(mutex_);
        state_.active = true;
      }
      uint64_t batches = 0;
      // Only seven seeds: precompute validation to leave CPU time for submission.
      double references[7];
      for (int i = 0; i < 7; ++i) references[i] = expected(.2f + i * .01f);
      while (!stop.load()) {
        const auto startedAt = monotonicMs();
        glUniform1f(seedLocation, .2f + (batches % 7) * .01f);
        glDispatchCompute(invocations / 64, 1, 1);
        glMemoryBarrier(GL_BUFFER_UPDATE_BARRIER_BIT);
        gl.fence = glFenceSync(GL_SYNC_GPU_COMMANDS_COMPLETE, 0);
        require(gl.fence != nullptr, "GPU completion fence creation failed");
        glFlush();
        for (;;) {
          const auto result = glClientWaitSync(gl.fence, 0, 20000000);
          if (result == GL_ALREADY_SIGNALED || result == GL_CONDITION_SATISFIED) break;
          require(result != GL_WAIT_FAILED, "GPU completion fence failed");
          require(monotonicMs() - startedAt < 2000, "GPU dispatch did not complete within two seconds");
        }
        glDeleteSync(gl.fence);
        gl.fence = nullptr;
        const auto values = static_cast<const float*>(glMapBufferRange(GL_SHADER_STORAGE_BUFFER, 0, 4 * sizeof(float), GL_MAP_READ_BIT));
        require(values != nullptr, "GPU result readback failed");
        const double checksum = double(values[0]) + values[1] + values[2] + values[3];
        require(glUnmapBuffer(GL_SHADER_STORAGE_BUFFER), "GPU result buffer became invalid");
        glCheck("Compute dispatch/readback");
        require(std::isfinite(checksum) && std::abs(checksum - references[batches % 7]) < .01,
                "GPU result did not match CPU reference");
        std::lock_guard<std::mutex> lock(mutex_);
        state_.batches = ++batches;
        state_.checksum = checksum;
        state_.lastBatchMs = monotonicMs() - startedAt;
      }
    } catch (const std::exception &error) {
      std::lock_guard<std::mutex> lock(mutex_);
      state_.active = false;
      state_.error = error.what();
      throw;
    }
    std::lock_guard<std::mutex> lock(mutex_);
    state_.active = false;
  }
};
} // namespace bench
