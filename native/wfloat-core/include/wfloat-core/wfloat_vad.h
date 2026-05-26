#ifndef WFLOAT_CORE_WFLOAT_VAD_H_
#define WFLOAT_CORE_WFLOAT_VAD_H_

#include <stddef.h>
#include <stdint.h>

#include "wfloat-core/wfloat_common.h"

#ifdef __cplusplus
extern "C" {
#endif

typedef struct wfloat_vad_model wfloat_vad_model_t;

typedef enum wfloat_vad_family {
  WFLOAT_VAD_FAMILY_UNKNOWN = 0,
  WFLOAT_VAD_FAMILY_SILERO = 1,
  WFLOAT_VAD_FAMILY_TEN = 2,
} wfloat_vad_family_t;

typedef enum wfloat_vad_feature_flags {
  WFLOAT_VAD_FEATURE_NONE = 0,
  WFLOAT_VAD_FEATURE_SEGMENTS = 1 << 0,
} wfloat_vad_feature_flags_t;

typedef struct wfloat_vad_model_config {
  const char *model_id;
  wfloat_vad_family_t family;
  const char *model_path;

  float threshold;
  float min_silence_duration_sec;
  float min_speech_duration_sec;
  float max_speech_duration_sec;
  int32_t sample_rate;
  int32_t window_size;
  int32_t num_threads;
  const char *provider;
  int32_t debug;
  float buffer_size_in_seconds;
} wfloat_vad_model_config_t;

typedef struct wfloat_vad_model_info {
  const char *model_id;
  const char *backend;
  const char *family;
  uint64_t feature_flags;
  int32_t sample_rate;
  int32_t window_size;
} wfloat_vad_model_info_t;

typedef struct wfloat_vad_segment {
  int32_t start_sample;
  const float *samples;
  size_t sample_count;
} wfloat_vad_segment_t;

wfloat_status_t wfloat_vad_model_create(
    const wfloat_vad_model_config_t *config,
    wfloat_vad_model_t **out_model);

void wfloat_vad_model_destroy(wfloat_vad_model_t *model);

wfloat_status_t wfloat_vad_model_get_info(
    const wfloat_vad_model_t *model,
    wfloat_vad_model_info_t *out_info);

wfloat_status_t wfloat_vad_model_accept_waveform(
    wfloat_vad_model_t *model,
    const float *samples,
    size_t sample_count);

wfloat_status_t wfloat_vad_model_reset(wfloat_vad_model_t *model);

wfloat_status_t wfloat_vad_model_flush(wfloat_vad_model_t *model);

wfloat_status_t wfloat_vad_model_empty(
    const wfloat_vad_model_t *model,
    int32_t *out_empty);

wfloat_status_t wfloat_vad_model_detected(
    const wfloat_vad_model_t *model,
    int32_t *out_detected);

wfloat_status_t wfloat_vad_model_front(
    const wfloat_vad_model_t *model,
    wfloat_vad_segment_t **out_segment);

wfloat_status_t wfloat_vad_model_pop(wfloat_vad_model_t *model);

wfloat_status_t wfloat_vad_model_clear(wfloat_vad_model_t *model);

void wfloat_vad_segment_destroy(wfloat_vad_segment_t *segment);

#ifdef __cplusplus
}  // extern "C"
#endif

#endif  // WFLOAT_CORE_WFLOAT_VAD_H_
