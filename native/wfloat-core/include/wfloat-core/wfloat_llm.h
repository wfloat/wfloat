#ifndef WFLOAT_CORE_WFLOAT_LLM_H_
#define WFLOAT_CORE_WFLOAT_LLM_H_

#include <stddef.h>
#include <stdint.h>

#include "wfloat-core/wfloat_common.h"

#ifdef __cplusplus
extern "C" {
#endif

/*
 * Draft shared LLM ABI for wfloat-core.
 *
 * This is the backend boundary for llama.cpp-style GGUF text generation. The
 * platform SDKs should still own async downloads, storage, UI streaming, and
 * app lifecycle integration.
 */

typedef struct wfloat_llm_model wfloat_llm_model_t;

typedef enum wfloat_llm_family {
  WFLOAT_LLM_FAMILY_UNKNOWN = 0,
  WFLOAT_LLM_FAMILY_LLAMA = 1,
  WFLOAT_LLM_FAMILY_QWEN = 2,
  WFLOAT_LLM_FAMILY_SMOLLM = 3,
  WFLOAT_LLM_FAMILY_GEMMA = 4,
  WFLOAT_LLM_FAMILY_MISTRAL = 5,
  WFLOAT_LLM_FAMILY_PHI = 6,
  WFLOAT_LLM_FAMILY_LIQUID = 7,
} wfloat_llm_family_t;

typedef enum wfloat_llm_feature_flags {
  WFLOAT_LLM_FEATURE_NONE = 0,
  WFLOAT_LLM_FEATURE_STREAMING = 1 << 0,
  WFLOAT_LLM_FEATURE_CHAT_TEMPLATE = 1 << 1,
  WFLOAT_LLM_FEATURE_TOOL_CALLING = 1 << 2,
  WFLOAT_LLM_FEATURE_EMBEDDINGS = 1 << 3,
} wfloat_llm_feature_flags_t;

typedef struct wfloat_llm_model_config {
  const char *model_id;
  wfloat_llm_family_t family;

  const char *model_path;
  const char *chat_template;
  const char *provider;

  int32_t context_size;
  int32_t num_threads;
  int32_t gpu_layer_count;
  int32_t seed;
} wfloat_llm_model_config_t;

typedef struct wfloat_llm_model_info {
  const char *model_id;
  const char *backend;
  const char *family;
  uint64_t feature_flags;
  int32_t context_size;
} wfloat_llm_model_info_t;

typedef struct wfloat_llm_generate_options {
  const char *prompt;
  int32_t max_tokens;
  float temperature;
  float top_p;
  int32_t top_k;
  float repeat_penalty;
  int32_t seed;
} wfloat_llm_generate_options_t;

typedef struct wfloat_llm_token_event {
  const char *text;
  int32_t token_index;
  int32_t token_id;
  int32_t is_done;
} wfloat_llm_token_event_t;

typedef int32_t (*wfloat_llm_token_callback_t)(
    const wfloat_llm_token_event_t *event,
    void *user_data);

typedef struct wfloat_llm_generate_result {
  const char *model_id;
  const char *text;
  const char *finish_reason;
  const char *json;
  int32_t prompt_token_count;
  int32_t completion_token_count;
} wfloat_llm_generate_result_t;

wfloat_status_t wfloat_llm_model_create(
    const wfloat_llm_model_config_t *config,
    wfloat_llm_model_t **out_model);

void wfloat_llm_model_destroy(wfloat_llm_model_t *model);

wfloat_status_t wfloat_llm_model_get_info(
    const wfloat_llm_model_t *model,
    wfloat_llm_model_info_t *out_info);

wfloat_status_t wfloat_llm_model_generate(
    wfloat_llm_model_t *model,
    const wfloat_llm_generate_options_t *options,
    wfloat_llm_token_callback_t token_callback,
    void *user_data,
    wfloat_llm_generate_result_t **out_result);

void wfloat_llm_generate_result_destroy(wfloat_llm_generate_result_t *result);

#ifdef __cplusplus
}  // extern "C"
#endif

#endif  // WFLOAT_CORE_WFLOAT_LLM_H_
