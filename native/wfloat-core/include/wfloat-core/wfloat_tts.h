#ifndef WFLOAT_CORE_WFLOAT_TTS_H_
#define WFLOAT_CORE_WFLOAT_TTS_H_

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/*
 * Draft shared TTS ABI for wfloat-core.
 *
 * This header is intentionally implementation-light. It defines the native
 * contract that web, React Native, and Python wrappers can converge on before
 * the backend plumbing is finalized.
 *
 * Non-goals for this layer:
 * - playback control
 * - autoplay behavior
 * - browser worker scheduling
 * - network download transport
 */

typedef struct wfloat_tts_model wfloat_tts_model_t;

typedef enum wfloat_tts_family {
  WFLOAT_TTS_FAMILY_UNKNOWN = 0,
  WFLOAT_TTS_FAMILY_WFLOAT_EXPRESSIVE = 1,
  WFLOAT_TTS_FAMILY_PIPER = 2,
  WFLOAT_TTS_FAMILY_MATCHA = 3,
  WFLOAT_TTS_FAMILY_KOKORO = 4,
  WFLOAT_TTS_FAMILY_ZIPVOICE = 5,
  WFLOAT_TTS_FAMILY_KITTEN = 6,
  WFLOAT_TTS_FAMILY_POCKET = 7,
} wfloat_tts_family_t;

typedef enum wfloat_status {
  WFLOAT_STATUS_OK = 0,
  WFLOAT_STATUS_INVALID_ARGUMENT = 1,
  WFLOAT_STATUS_NOT_SUPPORTED = 2,
  WFLOAT_STATUS_CANCELLED = 3,
  WFLOAT_STATUS_BACKEND_ERROR = 4,
  WFLOAT_STATUS_INTERNAL_ERROR = 5,
} wfloat_status_t;

typedef enum wfloat_tts_progress_stage {
  WFLOAT_TTS_PROGRESS_STAGE_PREPARING = 0,
  WFLOAT_TTS_PROGRESS_STAGE_GENERATING = 1,
  WFLOAT_TTS_PROGRESS_STAGE_COMPLETED = 2,
} wfloat_tts_progress_stage_t;

typedef enum wfloat_tts_feature_flags {
  WFLOAT_TTS_FEATURE_NONE = 0,
  WFLOAT_TTS_FEATURE_DIALOGUE = 1 << 0,
  WFLOAT_TTS_FEATURE_EMOTION = 1 << 1,
  WFLOAT_TTS_FEATURE_SPEAKER_SELECTION = 1 << 2,
  WFLOAT_TTS_FEATURE_LEXICON = 1 << 3,
  WFLOAT_TTS_FEATURE_TIMELINE = 1 << 4,
  WFLOAT_TTS_FEATURE_PHONEME_CONVERSION = 1 << 5,
  WFLOAT_TTS_FEATURE_REFERENCE_AUDIO = 1 << 6,
} wfloat_tts_feature_flags_t;

typedef struct wfloat_audio_result {
  const float *samples;
  size_t sample_count;
  int32_t sample_rate;
  float duration_sec;
} wfloat_audio_result_t;

typedef struct wfloat_string_map_entry {
  const char *key;
  const char *value;
} wfloat_string_map_entry_t;

typedef struct wfloat_tts_timeline_chunk {
  int32_t index;
  const char *text;
  int32_t highlight_start;
  int32_t highlight_end;
  float start_sec;
  float end_sec;
  float duration_sec;
  float progress;
  const char *voice;
  int32_t sid;
  int32_t segment_index;
} wfloat_tts_timeline_chunk_t;

typedef struct wfloat_tts_timeline {
  const wfloat_tts_timeline_chunk_t *chunks;
  size_t chunk_count;
  float duration_sec;
} wfloat_tts_timeline_t;

typedef struct wfloat_tts_progress_event {
  wfloat_tts_progress_stage_t stage;
  float progress;
  int32_t chunk_index;
  int32_t chunk_count;
  const char *text;
  int32_t highlight_start;
  int32_t highlight_end;
} wfloat_tts_progress_event_t;

typedef struct wfloat_tts_synthesis_result {
  wfloat_audio_result_t audio;
  wfloat_tts_timeline_t timeline;
  const char *model_id;
  const char *text;
} wfloat_tts_synthesis_result_t;

typedef struct wfloat_tts_synthesize_options {
  const char *text;
  const char *voice;
  int32_t sid;
  float speed;
  float silence_padding_sec;
  const float *reference_audio;
  size_t reference_audio_sample_count;
  int32_t reference_audio_sample_rate;
  const char *reference_text;
  int32_t num_steps;
  const wfloat_string_map_entry_t *extra_entries;
  size_t extra_entry_count;
} wfloat_tts_synthesize_options_t;

typedef struct wfloat_tts_dialogue_segment {
  const char *text;
  const char *voice;
  int32_t sid;
  float speed;
  float silence_padding_sec;
  const wfloat_string_map_entry_t *extra_entries;
  size_t extra_entry_count;
} wfloat_tts_dialogue_segment_t;

typedef struct wfloat_tts_dialogue_options {
  const wfloat_tts_dialogue_segment_t *segments;
  size_t segment_count;
  float silence_between_segments_sec;
} wfloat_tts_dialogue_options_t;

typedef int32_t (*wfloat_tts_progress_callback_t)(
    const wfloat_tts_progress_event_t *event,
    void *user_data);

/*
 * Fills model-level metadata that wrappers can expose without starting
 * synthesis.
 */
typedef struct wfloat_tts_model_info {
  const char *model_id;
  const char *backend;
  const char *family;
  uint64_t feature_flags;
  int32_t sample_rate;
  int32_t num_speakers;
} wfloat_tts_model_info_t;

typedef struct wfloat_tts_model_config {
  const char *model_id;
  wfloat_tts_family_t family;

  const char *model_path;
  const char *tokens_path;
  const char *data_dir;
  const char *lexicon_path;
  const char *voices_path;
  const char *lang;

  const char *acoustic_model_path;
  const char *vocoder_path;

  const char *encoder_path;
  const char *decoder_path;
  const char *text_conditioner_path;
  const char *lm_flow_path;
  const char *lm_main_path;
  const char *vocab_json_path;
  const char *token_scores_json_path;

  int32_t num_threads;
  int32_t debug;
  const char *provider;

  const char *rule_fsts;
  const char *rule_fars;
  int32_t max_num_sentences;
  float silence_scale;

  float noise_scale;
  float noise_scale_w;
  float length_scale;
  float feat_scale;
  float t_shift;
  float target_rms;
  float guidance_scale;
} wfloat_tts_model_config_t;

/*
 * The implementation is expected to stage any heap-backed strings, samples, and
 * timeline arrays inside the returned result object. Call the corresponding
 * destroy function when done.
 */
wfloat_status_t wfloat_tts_model_create(
    const wfloat_tts_model_config_t *config,
    wfloat_tts_model_t **out_model);

void wfloat_tts_model_destroy(wfloat_tts_model_t *model);

wfloat_status_t wfloat_tts_model_get_info(
    const wfloat_tts_model_t *model,
    wfloat_tts_model_info_t *out_info);

wfloat_status_t wfloat_tts_model_synthesize(
    const wfloat_tts_model_t *model,
    const wfloat_tts_synthesize_options_t *options,
    wfloat_tts_progress_callback_t progress_callback,
    void *user_data,
    wfloat_tts_synthesis_result_t **out_result);

wfloat_status_t wfloat_tts_model_synthesize_dialogue(
    const wfloat_tts_model_t *model,
    const wfloat_tts_dialogue_options_t *options,
    wfloat_tts_progress_callback_t progress_callback,
    void *user_data,
    wfloat_tts_synthesis_result_t **out_result);

void wfloat_tts_synthesis_result_destroy(wfloat_tts_synthesis_result_t *result);

#ifdef __cplusplus
}  // extern "C"
#endif

#endif  // WFLOAT_CORE_WFLOAT_TTS_H_
