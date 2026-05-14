// sherpa-onnx/csrc/offline-tts-wfloat-model-meta-data.h
//
// Copyright (c)  2026  Xiaomi Corporation

#ifndef SHERPA_ONNX_CSRC_OFFLINE_TTS_WFLOAT_MODEL_META_DATA_H_
#define SHERPA_ONNX_CSRC_OFFLINE_TTS_WFLOAT_MODEL_META_DATA_H_

#include "sherpa-onnx/csrc/offline-tts-vits-model-meta-data.h"

namespace sherpa_onnx {

// Keep binary-compatible metadata with VITS so shared frontend helpers
// continue to work, while allowing Wfloat to diverge later.
struct OfflineTtsWfloatModelMetaData : public OfflineTtsVitsModelMetaData {
};

}  // namespace sherpa_onnx

#endif  // SHERPA_ONNX_CSRC_OFFLINE_TTS_WFLOAT_MODEL_META_DATA_H_
