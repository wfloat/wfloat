// sherpa-onnx/csrc/offline-tts-wfloat-model-config.cc
//
// Copyright (c)  2026  Xiaomi Corporation

#include "sherpa-onnx/csrc/offline-tts-wfloat-model-config.h"

#include <string>
#include <vector>

#include "sherpa-onnx/csrc/file-utils.h"
#include "sherpa-onnx/csrc/macros.h"

namespace sherpa_onnx {

void OfflineTtsWfloatModelConfig::Register(ParseOptions *po) {
  po->Register("wfloat-model", &model, "Path to Wfloat model");
  po->Register("wfloat-lexicon", &lexicon,
               "Path to lexicon.txt for Wfloat models");
  po->Register("wfloat-tokens", &tokens, "Path to tokens.txt for Wfloat models");
  po->Register(
      "wfloat-data-dir", &data_dir,
      "Path to the directory containing dict for espeak-ng. If it is given, "
      "--wfloat-lexicon is ignored.");
  po->Register("wfloat-dict-dir", &dict_dir,
               "Not used. You don't need to provide a value for it");
  po->Register("wfloat-noise-scale", &noise_scale,
               "noise_scale for Wfloat models");
  po->Register("wfloat-noise-scale-w", &noise_scale_w,
               "noise_scale_w for Wfloat models");
  po->Register("wfloat-length-scale", &length_scale,
               "Speech speed. Larger->Slower; Smaller->faster.");
}

bool OfflineTtsWfloatModelConfig::Validate() const {
  if (model.empty()) {
    SHERPA_ONNX_LOGE("Please provide --wfloat-model");
    return false;
  }

  if (!FileExists(model)) {
    SHERPA_ONNX_LOGE("--wfloat-model: '%s' does not exist", model.c_str());
    return false;
  }

  if (tokens.empty()) {
    SHERPA_ONNX_LOGE("Please provide --wfloat-tokens");
    return false;
  }

  if (!FileExists(tokens)) {
    SHERPA_ONNX_LOGE("--wfloat-tokens: '%s' does not exist", tokens.c_str());
    return false;
  }

  if (!data_dir.empty()) {
    if (!FileExists(data_dir + "/phontab")) {
      SHERPA_ONNX_LOGE(
          "'%s/phontab' does not exist. Please check --wfloat-data-dir",
          data_dir.c_str());
      return false;
    }

    if (!FileExists(data_dir + "/phonindex")) {
      SHERPA_ONNX_LOGE(
          "'%s/phonindex' does not exist. Please check --wfloat-data-dir",
          data_dir.c_str());
      return false;
    }

    if (!FileExists(data_dir + "/phondata")) {
      SHERPA_ONNX_LOGE(
          "'%s/phondata' does not exist. Please check --wfloat-data-dir",
          data_dir.c_str());
      return false;
    }

    if (!FileExists(data_dir + "/intonations")) {
      SHERPA_ONNX_LOGE(
          "'%s/intonations' does not exist. Please check --wfloat-data-dir",
          data_dir.c_str());
      return false;
    }
  }

  if (!dict_dir.empty()) {
    SHERPA_ONNX_LOGE(
        "From sherpa-onnx v1.12.15, you don't need to provide dict_dir for "
        "this model. Ignore it");
  }

  return true;
}

std::string OfflineTtsWfloatModelConfig::ToString() const {
  std::ostringstream os;

  os << "OfflineTtsWfloatModelConfig(";
  os << "model=\"" << model << "\", ";
  os << "lexicon=\"" << lexicon << "\", ";
  os << "tokens=\"" << tokens << "\", ";
  os << "data_dir=\"" << data_dir << "\", ";
  os << "noise_scale=" << noise_scale << ", ";
  os << "noise_scale_w=" << noise_scale_w << ", ";
  os << "length_scale=" << length_scale << ")";

  return os.str();
}

}  // namespace sherpa_onnx
