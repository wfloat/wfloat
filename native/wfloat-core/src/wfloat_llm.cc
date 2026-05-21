#include "wfloat-core/wfloat_llm.h"

#include <stddef.h>
#include <stdint.h>

#include <memory>
#include <string>

struct wfloat_llm_model {
  std::string model_id;
  std::string backend = "llama.cpp";
  std::string family_name;
  uint64_t feature_flags = WFLOAT_LLM_FEATURE_STREAMING;
  int32_t context_size = 0;
};

namespace {

std::string OrEmpty(const char *value) {
  return value ? std::string(value) : std::string();
}

bool IsNullOrEmpty(const char *value) {
  return value == nullptr || *value == '\0';
}

const char *FamilyName(wfloat_llm_family_t family) {
  switch (family) {
    case WFLOAT_LLM_FAMILY_LLAMA:
      return "llama";
    case WFLOAT_LLM_FAMILY_QWEN:
      return "qwen";
    case WFLOAT_LLM_FAMILY_SMOLLM:
      return "smollm";
    case WFLOAT_LLM_FAMILY_GEMMA:
      return "gemma";
    case WFLOAT_LLM_FAMILY_MISTRAL:
      return "mistral";
    case WFLOAT_LLM_FAMILY_PHI:
      return "phi";
    case WFLOAT_LLM_FAMILY_LIQUID:
      return "liquid";
    case WFLOAT_LLM_FAMILY_UNKNOWN:
    default:
      return "unknown";
  }
}

uint64_t FeatureFlagsForConfig(const wfloat_llm_model_config_t &config) {
  uint64_t flags = WFLOAT_LLM_FEATURE_STREAMING;

  if (!IsNullOrEmpty(config.chat_template)) {
    flags |= WFLOAT_LLM_FEATURE_CHAT_TEMPLATE;
  }

  switch (config.family) {
    case WFLOAT_LLM_FAMILY_QWEN:
    case WFLOAT_LLM_FAMILY_LIQUID:
      flags |= WFLOAT_LLM_FEATURE_TOOL_CALLING;
      flags |= WFLOAT_LLM_FEATURE_EMBEDDINGS;
      break;
    case WFLOAT_LLM_FAMILY_LLAMA:
    case WFLOAT_LLM_FAMILY_SMOLLM:
    case WFLOAT_LLM_FAMILY_GEMMA:
    case WFLOAT_LLM_FAMILY_MISTRAL:
    case WFLOAT_LLM_FAMILY_PHI:
    case WFLOAT_LLM_FAMILY_UNKNOWN:
    default:
      break;
  }

  return flags;
}

}  // namespace

wfloat_status_t wfloat_llm_model_create(
    const wfloat_llm_model_config_t *config,
    wfloat_llm_model_t **out_model) {
  if (!config || !out_model || IsNullOrEmpty(config->model_id) ||
      IsNullOrEmpty(config->model_path) ||
      config->family == WFLOAT_LLM_FAMILY_UNKNOWN) {
    return WFLOAT_STATUS_INVALID_ARGUMENT;
  }

  *out_model = nullptr;

  /*
   * llama.cpp has not been imported into this checkout yet. Keep validation and
   * ABI shape in place, but fail explicitly instead of constructing a fake
   * model that would make wrappers think generation is available.
   */
  return WFLOAT_STATUS_NOT_SUPPORTED;
}

void wfloat_llm_model_destroy(wfloat_llm_model_t *model) {
  delete model;
}

wfloat_status_t wfloat_llm_model_get_info(
    const wfloat_llm_model_t *model,
    wfloat_llm_model_info_t *out_info) {
  if (!model || !out_info) {
    return WFLOAT_STATUS_INVALID_ARGUMENT;
  }

  out_info->model_id = model->model_id.c_str();
  out_info->backend = model->backend.c_str();
  out_info->family = model->family_name.c_str();
  out_info->feature_flags = model->feature_flags;
  out_info->context_size = model->context_size;
  return WFLOAT_STATUS_OK;
}

wfloat_status_t wfloat_llm_model_generate(
    wfloat_llm_model_t *model,
    const wfloat_llm_generate_options_t *options,
    wfloat_llm_token_callback_t token_callback,
    void *user_data,
    wfloat_llm_generate_result_t **out_result) {
  (void)token_callback;
  (void)user_data;

  if (!model || !options || !out_result || IsNullOrEmpty(options->prompt)) {
    return WFLOAT_STATUS_INVALID_ARGUMENT;
  }

  *out_result = nullptr;
  return WFLOAT_STATUS_NOT_SUPPORTED;
}

void wfloat_llm_generate_result_destroy(wfloat_llm_generate_result_t *result) {
  delete result;
}
