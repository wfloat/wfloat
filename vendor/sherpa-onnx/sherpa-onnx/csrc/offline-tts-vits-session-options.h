// Copyright (c) 2026 Wfloat
#ifndef SHERPA_ONNX_CSRC_OFFLINE_TTS_VITS_SESSION_OPTIONS_H_
#define SHERPA_ONNX_CSRC_OFFLINE_TTS_VITS_SESSION_OPTIONS_H_

#include <string>

#include "onnxruntime_cxx_api.h"

namespace sherpa_onnx {

inline void ApplyVitsSessionCompatibility(Ort::SessionOptions &options) {
  // LibriTTS on ORT 1.18.1 succeeds once, then reuses an invalid memory
  // pattern on subsequent runs. Predicted durations depend on input values
  // and random samples, so intermediate sizes can change for identical input
  // shapes. Disabling only pattern reuse fixes repeated/mixed-speaker runs;
  // retain graph optimizations and the CPU arena. ORT 1.17.1 passes the same
  // control. Limit this workaround to the demonstrated affected version.
  if (std::string(OrtGetApiBase()->GetVersionString()) == "1.18.1") {
    options.DisableMemPattern();
  }
}

}  // namespace sherpa_onnx
#endif  // SHERPA_ONNX_CSRC_OFFLINE_TTS_VITS_SESSION_OPTIONS_H_
