#ifndef WFLOAT_CORE_WFLOAT_STT_H_
#define WFLOAT_CORE_WFLOAT_STT_H_

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/*
 * Draft shared STT ABI for wfloat-core.
 *
 * Offline transcription is implemented first. Streaming/session semantics are
 * now part of the ABI draft so wrappers can converge on one shape even before
 * every backend family implements it.
 */

typedef struct wfloat_stt_model wfloat_stt_model_t;
typedef struct wfloat_stt_session wfloat_stt_session_t;

typedef enum wfloat_stt_family {
  WFLOAT_STT_FAMILY_UNKNOWN = 0,
  WFLOAT_STT_FAMILY_WHISPER = 1,
  WFLOAT_STT_FAMILY_MOONSHINE = 2,
  WFLOAT_STT_FAMILY_PARAKEET_CTC = 3,
  WFLOAT_STT_FAMILY_PARAKEET_TDT = 4,
  WFLOAT_STT_FAMILY_ZIPFORMER_TRANSDUCER = 5,
} wfloat_stt_family_t;

typedef enum wfloat_stt_feature_flags {
  WFLOAT_STT_FEATURE_NONE = 0,
  WFLOAT_STT_FEATURE_TOKENS = 1 << 0,
  WFLOAT_STT_FEATURE_TIMESTAMPS = 1 << 1,
  WFLOAT_STT_FEATURE_DURATIONS = 1 << 2,
  WFLOAT_STT_FEATURE_SEGMENTS = 1 << 3,
  WFLOAT_STT_FEATURE_LANGUAGE = 1 << 4,
  WFLOAT_STT_FEATURE_EMOTION = 1 << 5,
  WFLOAT_STT_FEATURE_EVENTS = 1 << 6,
  WFLOAT_STT_FEATURE_STREAMING = 1 << 7,
} wfloat_stt_feature_flags_t;

typedef struct wfloat_stt_token {
  const char *text;
  float start_sec;
  float duration_sec;
  float confidence;
} wfloat_stt_token_t;

typedef struct wfloat_stt_segment {
  const char *text;
  float start_sec;
  float duration_sec;
} wfloat_stt_segment_t;

typedef struct wfloat_stt_transcription_result {
  const char *model_id;
  const char *text;
  const char *language;
  const char *emotion;
  const char *event;
  const char *json;

  const wfloat_stt_token_t *tokens;
  size_t token_count;

  const wfloat_stt_segment_t *segments;
  size_t segment_count;
} wfloat_stt_transcription_result_t;

typedef struct wfloat_stt_session_result {
  const char *model_id;
  const char *text;
  const char *json;
  int32_t is_endpoint;
} wfloat_stt_session_result_t;

typedef struct wfloat_stt_model_info {
  const char *model_id;
  const char *backend;
  const char *family;
  uint64_t feature_flags;
  int32_t sample_rate;
  int32_t supports_language_override;
} wfloat_stt_model_info_t;

typedef struct wfloat_stt_model_config {
  const char *model_id;
  wfloat_stt_family_t family;

  const char *model_path;
  const char *tokens_path;
  const char *preprocessor_path;
  const char *encoder_path;
  const char *decoder_path;
  const char *joiner_path;
  const char *uncached_decoder_path;
  const char *cached_decoder_path;
  const char *provider;

  const char *language;
  const char *task;
  const char *hotwords_file;
  const char *rule_fsts;
  const char *rule_fars;

  int32_t sample_rate;
  int32_t feat_dim;
  int32_t num_threads;
  int32_t debug;
  int32_t max_active_paths;
  int32_t tail_paddings;
  int32_t enable_token_timestamps;
  int32_t enable_segment_timestamps;

  float hotwords_score;
  float blank_penalty;
} wfloat_stt_model_config_t;

typedef struct wfloat_stt_transcribe_options {
  const float *samples;
  size_t sample_count;
  int32_t sample_rate;

  const char *language;
  const char *task;
  const char *hotwords;
} wfloat_stt_transcribe_options_t;

int32_t wfloat_stt_model_create(
    const wfloat_stt_model_config_t *config,
    wfloat_stt_model_t **out_model);

void wfloat_stt_model_destroy(wfloat_stt_model_t *model);

int32_t wfloat_stt_model_get_info(
    const wfloat_stt_model_t *model,
    wfloat_stt_model_info_t *out_info);

int32_t wfloat_stt_model_transcribe(
    const wfloat_stt_model_t *model,
    const wfloat_stt_transcribe_options_t *options,
    wfloat_stt_transcription_result_t **out_result);

int32_t wfloat_stt_model_create_session(
    const wfloat_stt_model_t *model,
    wfloat_stt_session_t **out_session);

int32_t wfloat_stt_session_push_audio(
    wfloat_stt_session_t *session,
    const float *samples,
    size_t sample_count,
    int32_t sample_rate);

int32_t wfloat_stt_session_get_result(
    wfloat_stt_session_t *session,
    wfloat_stt_session_result_t **out_result);

int32_t wfloat_stt_session_finish(
    wfloat_stt_session_t *session,
    wfloat_stt_session_result_t **out_result);

int32_t wfloat_stt_session_reset(wfloat_stt_session_t *session);

void wfloat_stt_session_destroy(wfloat_stt_session_t *session);

void wfloat_stt_transcription_result_destroy(
    wfloat_stt_transcription_result_t *result);

void wfloat_stt_session_result_destroy(
    wfloat_stt_session_result_t *result);

#ifdef __cplusplus
}  // extern "C"
#endif

#endif  // WFLOAT_CORE_WFLOAT_STT_H_
