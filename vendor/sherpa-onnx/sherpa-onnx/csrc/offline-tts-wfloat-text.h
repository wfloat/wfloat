// sherpa-onnx/csrc/offline-tts-wfloat-text.h
//
// Copyright (c) 2026 Wfloat

#ifndef SHERPA_ONNX_CSRC_OFFLINE_TTS_WFLOAT_TEXT_H_
#define SHERPA_ONNX_CSRC_OFFLINE_TTS_WFLOAT_TEXT_H_

#include <string>
#include <vector>

namespace sherpa_onnx {

struct WfloatPreparedText {
  std::vector<std::string> text;
  std::vector<std::string> text_clean;
  std::vector<std::string> text_phonemes;
};

WfloatPreparedText PrepareWfloatText(const std::string &text,
                                     const std::string &emotion = "",
                                     float intensity = 0.0f);

}  // namespace sherpa_onnx

#endif  // SHERPA_ONNX_CSRC_OFFLINE_TTS_WFLOAT_TEXT_H_
