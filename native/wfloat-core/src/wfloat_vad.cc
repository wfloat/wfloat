#include "wfloat-core/wfloat_vad.h"

#include <stddef.h>
#include <stdint.h>

#include <memory>
#include <algorithm>
#include <array>
#include <cmath>
#include <string>
#include <vector>

#include "sherpa-onnx/c-api/c-api.h"
#include "sherpa-onnx/csrc/vad-model.h"

struct wfloat_vad_model {
  std::string model_id;
  std::string backend = "sherpa-onnx";
  std::string family_name;
  uint64_t feature_flags = WFLOAT_VAD_FEATURE_SEGMENTS;
  int32_t sample_rate = 16000;
  int32_t window_size = 512;
  const SherpaOnnxVoiceActivityDetector *detector = nullptr;
  sherpa_onnx::VadModelConfig scorer_config;
  std::unique_ptr<sherpa_onnx::VadModel> scorer;
  std::array<float, 576> scorer_input{};
  int32_t scorer_context = 0;
  bool scorer_failed = false;
};

namespace {

constexpr int32_t kDefaultSampleRate = 16000;
constexpr int32_t kDefaultThreads = 1;
constexpr float kDefaultThreshold = 0.5f;
constexpr float kDefaultMinSilenceDurationSec = 0.5f;
constexpr float kDefaultMinSpeechDurationSec = 0.25f;
constexpr float kDefaultMaxSpeechDurationSec = 20.0f;
constexpr float kDefaultBufferSizeInSeconds = 30.0f;

struct OwnedVadSegment {
  wfloat_vad_segment_t base{};
  std::vector<float> samples;

  void Finalize() {
    base.samples = samples.empty() ? nullptr : samples.data();
    base.sample_count = samples.size();
  }
};

bool IsNullOrEmpty(const char *value) {
  return value == nullptr || *value == '\0';
}

int32_t DefaultPositive(int32_t value, int32_t default_value) {
  return value > 0 ? value : default_value;
}

float DefaultPositive(float value, float default_value) {
  return value > 0.0f ? value : default_value;
}

float DefaultNonNegative(float value, float default_value) {
  return value >= 0.0f ? value : default_value;
}

const char *FamilyName(wfloat_vad_family_t family) {
  switch (family) {
    case WFLOAT_VAD_FAMILY_SILERO:
      return "silero-vad";
    case WFLOAT_VAD_FAMILY_TEN:
      return "ten-vad";
    case WFLOAT_VAD_FAMILY_UNKNOWN:
    default:
      return "unknown";
  }
}

int32_t WindowSizeForConfig(const wfloat_vad_model_config_t *config) {
  if (config->window_size > 0) {
    return config->window_size;
  }

  return config->family == WFLOAT_VAD_FAMILY_TEN ? 256 : 512;
}

wfloat_status_t BuildSherpaConfig(const wfloat_vad_model_config_t *config,
                                  SherpaOnnxVadModelConfig *out_config) {
  if (!config || !out_config || config->family == WFLOAT_VAD_FAMILY_UNKNOWN ||
      IsNullOrEmpty(config->model_id) || IsNullOrEmpty(config->model_path)) {
    return WFLOAT_STATUS_INVALID_ARGUMENT;
  }

  SherpaOnnxVadModelConfig sherpa_config{};
  const int32_t window_size = WindowSizeForConfig(config);
  const float threshold =
      DefaultPositive(config->threshold, kDefaultThreshold);
  const float min_silence_duration_sec = DefaultNonNegative(
      config->min_silence_duration_sec, kDefaultMinSilenceDurationSec);
  const float min_speech_duration_sec = DefaultNonNegative(
      config->min_speech_duration_sec, kDefaultMinSpeechDurationSec);
  const float max_speech_duration_sec = DefaultPositive(
      config->max_speech_duration_sec, kDefaultMaxSpeechDurationSec);

  if (config->family == WFLOAT_VAD_FAMILY_SILERO) {
    sherpa_config.silero_vad.model = config->model_path;
    sherpa_config.silero_vad.threshold = threshold;
    sherpa_config.silero_vad.min_silence_duration =
        min_silence_duration_sec;
    sherpa_config.silero_vad.min_speech_duration = min_speech_duration_sec;
    sherpa_config.silero_vad.window_size = window_size;
    sherpa_config.silero_vad.max_speech_duration = max_speech_duration_sec;
  } else if (config->family == WFLOAT_VAD_FAMILY_TEN) {
    sherpa_config.ten_vad.model = config->model_path;
    sherpa_config.ten_vad.threshold = threshold;
    sherpa_config.ten_vad.min_silence_duration = min_silence_duration_sec;
    sherpa_config.ten_vad.min_speech_duration = min_speech_duration_sec;
    sherpa_config.ten_vad.window_size = window_size;
    sherpa_config.ten_vad.max_speech_duration = max_speech_duration_sec;
  } else {
    return WFLOAT_STATUS_NOT_SUPPORTED;
  }

  sherpa_config.sample_rate =
      DefaultPositive(config->sample_rate, kDefaultSampleRate);
  sherpa_config.num_threads =
      DefaultPositive(config->num_threads, kDefaultThreads);
  sherpa_config.provider = IsNullOrEmpty(config->provider)
                               ? "cpu"
                               : config->provider;
  sherpa_config.debug = config->debug;

  *out_config = sherpa_config;
  return WFLOAT_STATUS_OK;
}

void DestroyDetector(wfloat_vad_model_t *model) {
  if (model && model->detector) {
    SherpaOnnxDestroyVoiceActivityDetector(model->detector);
    model->detector = nullptr;
  }
}

}  // namespace

wfloat_status_t wfloat_vad_model_create(
    const wfloat_vad_model_config_t *config,
    wfloat_vad_model_t **out_model) {
  if (!out_model) {
    return WFLOAT_STATUS_INVALID_ARGUMENT;
  }
  *out_model = nullptr;

  SherpaOnnxVadModelConfig sherpa_config{};
  wfloat_status_t status = BuildSherpaConfig(config, &sherpa_config);
  if (status != WFLOAT_STATUS_OK) {
    return status;
  }

  const float buffer_size_in_seconds = DefaultPositive(
      config->buffer_size_in_seconds, kDefaultBufferSizeInSeconds);
  const SherpaOnnxVoiceActivityDetector *detector =
      SherpaOnnxCreateVoiceActivityDetector(&sherpa_config,
                                            buffer_size_in_seconds);
  if (!detector) {
    return WFLOAT_STATUS_BACKEND_ERROR;
  }

  std::unique_ptr<wfloat_vad_model_t> model(new wfloat_vad_model_t);
  model->model_id = config->model_id;
  model->family_name = FamilyName(config->family);
  model->sample_rate = sherpa_config.sample_rate;
  model->window_size = WindowSizeForConfig(config);
  model->detector = detector;
  if (config->family == WFLOAT_VAD_FAMILY_SILERO &&
      model->sample_rate == 16000 && model->window_size == 512) {
    model->feature_flags |= WFLOAT_VAD_FEATURE_PROBABILITIES;
    model->scorer_config.silero_vad.model = config->model_path;
    model->scorer_config.silero_vad.window_size = 512;
    model->scorer_config.sample_rate = model->sample_rate;
    model->scorer_config.num_threads = sherpa_config.num_threads;
    model->scorer_config.provider = sherpa_config.provider;
  }

  *out_model = model.release();
  return WFLOAT_STATUS_OK;
}

void wfloat_vad_model_destroy(wfloat_vad_model_t *model) {
  DestroyDetector(model);
  delete model;
}

wfloat_status_t wfloat_vad_model_get_info(
    const wfloat_vad_model_t *model,
    wfloat_vad_model_info_t *out_info) {
  if (!model || !out_info) {
    return WFLOAT_STATUS_INVALID_ARGUMENT;
  }

  out_info->model_id = model->model_id.c_str();
  out_info->backend = model->backend.c_str();
  out_info->family = model->family_name.c_str();
  out_info->feature_flags = model->feature_flags;
  out_info->sample_rate = model->sample_rate;
  out_info->window_size = model->window_size;
  return WFLOAT_STATUS_OK;
}

wfloat_status_t wfloat_vad_model_accept_waveform(
    wfloat_vad_model_t *model,
    const float *samples,
    size_t sample_count) {
  if (!model || !model->detector || (!samples && sample_count > 0)) {
    return WFLOAT_STATUS_INVALID_ARGUMENT;
  }
  if (sample_count == 0) {
    return WFLOAT_STATUS_OK;
  }

  SherpaOnnxVoiceActivityDetectorAcceptWaveform(
      model->detector, samples, static_cast<int32_t>(sample_count));
  return WFLOAT_STATUS_OK;
}

wfloat_status_t wfloat_vad_model_reset(wfloat_vad_model_t *model) {
  if (!model || !model->detector) {
    return WFLOAT_STATUS_INVALID_ARGUMENT;
  }

  try {
    SherpaOnnxVoiceActivityDetectorReset(model->detector);
    if (model->scorer) model->scorer->Reset();
    model->scorer_input.fill(0);
    model->scorer_failed = false;
  } catch (...) {
    model->scorer_failed = true;
    return WFLOAT_STATUS_BACKEND_ERROR;
  }
  return WFLOAT_STATUS_OK;
}

wfloat_status_t wfloat_vad_model_score_frame(
    wfloat_vad_model_t *model, const float *samples, size_t sample_count,
    float *out_probability) {
  if (!model || !samples || !out_probability || sample_count != 512)
    return WFLOAT_STATUS_INVALID_ARGUMENT;
  if (!(model->feature_flags & WFLOAT_VAD_FEATURE_PROBABILITIES))
    return WFLOAT_STATUS_NOT_SUPPORTED;
  if (model->scorer_failed) return WFLOAT_STATUS_BACKEND_ERROR;
  for (size_t i = 0; i < sample_count; ++i)
    if (!std::isfinite(samples[i])) return WFLOAT_STATUS_INVALID_ARGUMENT;
  try {
    if (!model->scorer) {
      model->scorer = sherpa_onnx::VadModel::Create(model->scorer_config);
      if (!model->scorer || model->scorer->WindowShift() != 512) {
        model->scorer_failed = true;
        return WFLOAT_STATUS_NOT_SUPPORTED;
      }
      model->scorer_context = model->scorer->WindowSize() - 512;
      if (model->scorer_context != 0 && model->scorer_context != 64) {
        model->scorer_failed = true;
        return WFLOAT_STATUS_NOT_SUPPORTED;
      }
    }
    std::copy(samples, samples + sample_count,
              model->scorer_input.begin() + model->scorer_context);
    float probability = model->scorer->Compute(
        model->scorer_input.data(), 512 + model->scorer_context);
    if (!std::isfinite(probability) || probability < 0 || probability > 1) {
      model->scorer_failed = true;
      return WFLOAT_STATUS_BACKEND_ERROR;
    }
    std::copy(samples + sample_count - model->scorer_context,
              samples + sample_count, model->scorer_input.begin());
    *out_probability = probability;
    return WFLOAT_STATUS_OK;
  } catch (...) {
    model->scorer_failed = true;
    return WFLOAT_STATUS_BACKEND_ERROR;
  }
}

wfloat_status_t wfloat_vad_model_flush(wfloat_vad_model_t *model) {
  if (!model || !model->detector) {
    return WFLOAT_STATUS_INVALID_ARGUMENT;
  }

  SherpaOnnxVoiceActivityDetectorFlush(model->detector);
  return WFLOAT_STATUS_OK;
}

wfloat_status_t wfloat_vad_model_empty(
    const wfloat_vad_model_t *model,
    int32_t *out_empty) {
  if (!model || !model->detector || !out_empty) {
    return WFLOAT_STATUS_INVALID_ARGUMENT;
  }

  *out_empty = SherpaOnnxVoiceActivityDetectorEmpty(model->detector);
  return WFLOAT_STATUS_OK;
}

wfloat_status_t wfloat_vad_model_detected(
    const wfloat_vad_model_t *model,
    int32_t *out_detected) {
  if (!model || !model->detector || !out_detected) {
    return WFLOAT_STATUS_INVALID_ARGUMENT;
  }

  *out_detected = SherpaOnnxVoiceActivityDetectorDetected(model->detector);
  return WFLOAT_STATUS_OK;
}

wfloat_status_t wfloat_vad_model_front(
    const wfloat_vad_model_t *model,
    wfloat_vad_segment_t **out_segment) {
  if (!model || !model->detector || !out_segment) {
    return WFLOAT_STATUS_INVALID_ARGUMENT;
  }
  *out_segment = nullptr;

  if (SherpaOnnxVoiceActivityDetectorEmpty(model->detector)) {
    return WFLOAT_STATUS_INVALID_ARGUMENT;
  }

  const SherpaOnnxSpeechSegment *sherpa_segment =
      SherpaOnnxVoiceActivityDetectorFront(model->detector);
  if (!sherpa_segment) {
    return WFLOAT_STATUS_BACKEND_ERROR;
  }

  std::unique_ptr<OwnedVadSegment> segment(new OwnedVadSegment);
  segment->base.start_sample = sherpa_segment->start;
  if (sherpa_segment->samples && sherpa_segment->n > 0) {
    segment->samples.assign(sherpa_segment->samples,
                            sherpa_segment->samples + sherpa_segment->n);
  }
  segment->Finalize();
  SherpaOnnxDestroySpeechSegment(sherpa_segment);

  *out_segment = &segment.release()->base;
  return WFLOAT_STATUS_OK;
}

wfloat_status_t wfloat_vad_model_pop(wfloat_vad_model_t *model) {
  if (!model || !model->detector) {
    return WFLOAT_STATUS_INVALID_ARGUMENT;
  }

  SherpaOnnxVoiceActivityDetectorPop(model->detector);
  return WFLOAT_STATUS_OK;
}

wfloat_status_t wfloat_vad_model_clear(wfloat_vad_model_t *model) {
  if (!model || !model->detector) {
    return WFLOAT_STATUS_INVALID_ARGUMENT;
  }

  SherpaOnnxVoiceActivityDetectorClear(model->detector);
  return WFLOAT_STATUS_OK;
}

void wfloat_vad_segment_destroy(wfloat_vad_segment_t *segment) {
  delete reinterpret_cast<OwnedVadSegment *>(segment);
}
