#include "wfloat-core/wfloat_llm.h"

#include <stddef.h>
#include <stdint.h>

#include <algorithm>
#include <exception>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#if WFLOAT_ENABLE_LLAMA_CPP
#include "llama.h"
#endif

struct wfloat_llm_model {
  std::string model_id;
  std::string backend = "llama.cpp";
  std::string family_name;
  std::string chat_template;
  uint64_t feature_flags = WFLOAT_LLM_FEATURE_STREAMING;
  int32_t context_size = 0;
  int32_t num_threads = 1;

#if WFLOAT_ENABLE_LLAMA_CPP
  llama_model *model = nullptr;
  llama_context *context = nullptr;
  const llama_vocab *vocab = nullptr;
  std::mutex mutex;
#endif
};

namespace {

constexpr int32_t kDefaultContextSize = 2048;
constexpr int32_t kDefaultMaxTokens = 128;
constexpr uint32_t kDefaultBatchSize = 512;

struct OwnedGenerateResult {
  wfloat_llm_generate_result_t base{};
  std::string model_id;
  std::string text;
  std::string finish_reason;
  std::string json;

  void Finalize() {
    base.model_id = model_id.c_str();
    base.text = text.c_str();
    base.finish_reason = finish_reason.c_str();
    base.json = json.empty() ? nullptr : json.c_str();
  }
};

struct OwnedChatTemplateResult {
  wfloat_llm_chat_template_result_t base{};
  std::string prompt;
  std::string chat_template;
  std::string json;
  bool used_fallback = false;

  void Finalize() {
    base.prompt = prompt.c_str();
    base.chat_template =
        chat_template.empty() ? nullptr : chat_template.c_str();
    base.json = json.empty() ? nullptr : json.c_str();
    base.used_fallback = used_fallback ? 1 : 0;
  }
};

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

int32_t DefaultPositive(int32_t value, int32_t default_value) {
  return value > 0 ? value : default_value;
}

float DefaultPositive(float value, float default_value) {
  return value > 0 ? value : default_value;
}

int32_t EffectiveThreadCount(int32_t requested_threads) {
  int32_t threads = DefaultPositive(requested_threads, 1);
  unsigned int hardware_threads = std::thread::hardware_concurrency();
  if (hardware_threads == 0) {
    return threads;
  }

  return std::min(threads, static_cast<int32_t>(hardware_threads));
}

#if WFLOAT_ENABLE_LLAMA_CPP
void FormatChatMlPrompt(const std::vector<llama_chat_message> &messages,
                        int32_t add_generation_prompt,
                        std::string *out_prompt) {
  out_prompt->clear();
  for (const llama_chat_message &message : messages) {
    *out_prompt += "<|im_start|>";
    *out_prompt += message.role;
    *out_prompt += "\n";
    *out_prompt += message.content;
    *out_prompt += "<|im_end|>\n";
  }
  if (add_generation_prompt != 0) {
    *out_prompt += "<|im_start|>assistant\n";
  }
}

void QuietLlamaLog(ggml_log_level level, const char *text, void *user_data) {
  (void)level;
  (void)text;
  (void)user_data;
}

void InitLlamaBackendOnce() {
  static std::once_flag once;
  std::call_once(once, [] {
    llama_log_set(QuietLlamaLog, nullptr);
    llama_backend_init();
    ggml_backend_load_all();
  });
}

std::vector<llama_token> Tokenize(const llama_vocab *vocab,
                                  const std::string &text) {
  int32_t token_count = -llama_tokenize(
      vocab, text.c_str(), static_cast<int32_t>(text.size()), nullptr, 0,
      true, true);
  if (token_count <= 0) {
    return {};
  }

  std::vector<llama_token> tokens(static_cast<size_t>(token_count));
  int32_t actual = llama_tokenize(
      vocab, text.c_str(), static_cast<int32_t>(text.size()), tokens.data(),
      static_cast<int32_t>(tokens.size()), true, true);
  if (actual < 0) {
    return {};
  }

  tokens.resize(static_cast<size_t>(actual));
  return tokens;
}

bool TokenToPiece(const llama_vocab *vocab, llama_token token,
                  std::string *out_piece) {
  char stack_buffer[256];
  int32_t written = llama_token_to_piece(
      vocab, token, stack_buffer, static_cast<int32_t>(sizeof(stack_buffer)),
      0, true);
  if (written >= 0) {
    out_piece->assign(stack_buffer, static_cast<size_t>(written));
    return true;
  }

  int32_t required = -written;
  if (required <= 0) {
    return false;
  }

  std::vector<char> buffer(static_cast<size_t>(required));
  written = llama_token_to_piece(vocab, token, buffer.data(), required, 0, true);
  if (written < 0) {
    return false;
  }

  out_piece->assign(buffer.data(), static_cast<size_t>(written));
  return true;
}

wfloat_status_t FormatChatPrompt(
    const wfloat_llm_model_t *model,
    const wfloat_llm_chat_template_options_t *options,
    std::string *out_prompt,
    bool *out_used_fallback) {
  if (!model || !options || !out_prompt || !out_used_fallback ||
      !options->messages ||
      options->message_count == 0) {
    return WFLOAT_STATUS_INVALID_ARGUMENT;
  }

  *out_used_fallback = false;

  std::vector<llama_chat_message> messages;
  messages.reserve(options->message_count);

  for (size_t i = 0; i < options->message_count; ++i) {
    const wfloat_llm_chat_message_t &message = options->messages[i];
    if (IsNullOrEmpty(message.role) || IsNullOrEmpty(message.content)) {
      return WFLOAT_STATUS_INVALID_ARGUMENT;
    }

    messages.push_back(llama_chat_message{
        message.role,
        message.content,
    });
  }

  if (model->chat_template == "chatml") {
    FormatChatMlPrompt(messages, options->add_generation_prompt, out_prompt);
    return WFLOAT_STATUS_OK;
  }

  const char *chat_template =
      model->chat_template.empty() ? nullptr : model->chat_template.c_str();
  int32_t required = -1;
  try {
    required = llama_chat_apply_template(
        chat_template, messages.data(), messages.size(),
        options->add_generation_prompt != 0, nullptr, 0);
  } catch (...) {
    required = -1;
  }

  if (required > 0) {
    std::vector<char> buffer(static_cast<size_t>(required) + 1, '\0');
    int32_t written = -1;
    try {
      written = llama_chat_apply_template(
          chat_template, messages.data(), messages.size(),
          options->add_generation_prompt != 0, buffer.data(),
          static_cast<int32_t>(buffer.size()));
    } catch (...) {
      written = -1;
    }

    if (written >= 0) {
      out_prompt->assign(buffer.data(), static_cast<size_t>(written));
      return WFLOAT_STATUS_OK;
    }
  }

  return WFLOAT_STATUS_BACKEND_ERROR;
}

llama_sampler *BuildSampler(const wfloat_llm_generate_options_t &options) {
  llama_sampler_chain_params params = llama_sampler_chain_default_params();
  params.no_perf = true;

  llama_sampler *sampler = llama_sampler_chain_init(params);
  if (!sampler) {
    return nullptr;
  }

  const float repeat_penalty =
      DefaultPositive(options.repeat_penalty, 1.0f);
  if (repeat_penalty != 1.0f) {
    llama_sampler_chain_add(
        sampler, llama_sampler_init_penalties(64, repeat_penalty, 0.0f, 0.0f));
  }

  const float temperature = options.temperature;
  if (temperature <= 0.0f) {
    llama_sampler_chain_add(sampler, llama_sampler_init_greedy());
    return sampler;
  }

  llama_sampler_chain_add(sampler, llama_sampler_init_top_k(options.top_k));
  llama_sampler_chain_add(
      sampler, llama_sampler_init_top_p(DefaultPositive(options.top_p, 0.95f),
                                        1));
  llama_sampler_chain_add(
      sampler, llama_sampler_init_temp(DefaultPositive(temperature, 0.8f)));
  llama_sampler_chain_add(
      sampler, llama_sampler_init_dist(static_cast<uint32_t>(options.seed)));
  return sampler;
}

void EmitDone(wfloat_llm_token_callback_t token_callback, void *user_data,
              int32_t token_index) {
  if (!token_callback) {
    return;
  }

  wfloat_llm_token_event_t event{};
  event.text = "";
  event.token_index = token_index;
  event.token_id = -1;
  event.is_done = 1;
  token_callback(&event, user_data);
}
#endif

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

#if WFLOAT_ENABLE_LLAMA_CPP
  try {
    InitLlamaBackendOnce();

    llama_model_params model_params = llama_model_default_params();
    model_params.n_gpu_layers = std::max(0, config->gpu_layer_count);

    llama_model *llama_model =
        llama_model_load_from_file(config->model_path, model_params);
    if (!llama_model) {
      return WFLOAT_STATUS_BACKEND_ERROR;
    }

    llama_context_params context_params = llama_context_default_params();
    context_params.n_ctx = static_cast<uint32_t>(
        DefaultPositive(config->context_size, kDefaultContextSize));
    context_params.n_batch = std::min(context_params.n_ctx, kDefaultBatchSize);
    context_params.n_ubatch = context_params.n_batch;
    context_params.n_threads = EffectiveThreadCount(config->num_threads);
    context_params.n_threads_batch = context_params.n_threads;
    context_params.no_perf = true;

    llama_context *context = llama_init_from_model(llama_model, context_params);
    if (!context) {
      llama_model_free(llama_model);
      return WFLOAT_STATUS_BACKEND_ERROR;
    }

    std::unique_ptr<wfloat_llm_model_t> model(new wfloat_llm_model_t);
    model->model_id = OrEmpty(config->model_id);
    model->family_name = FamilyName(config->family);
    model->chat_template = OrEmpty(config->chat_template);
    if (model->chat_template.empty()) {
      const char *metadata_template = llama_model_chat_template(llama_model, nullptr);
      model->chat_template = OrEmpty(metadata_template);
    }
    model->feature_flags = FeatureFlagsForConfig(*config);
    if (!model->chat_template.empty()) {
      model->feature_flags |= WFLOAT_LLM_FEATURE_CHAT_TEMPLATE;
    }
    model->context_size = static_cast<int32_t>(llama_n_ctx(context));
    model->num_threads = context_params.n_threads;
    model->model = llama_model;
    model->context = context;
    model->vocab = llama_model_get_vocab(llama_model);

    *out_model = model.release();
    return WFLOAT_STATUS_OK;
  } catch (const std::exception &) {
    return WFLOAT_STATUS_BACKEND_ERROR;
  } catch (...) {
    return WFLOAT_STATUS_INTERNAL_ERROR;
  }
#else
  return WFLOAT_STATUS_NOT_SUPPORTED;
#endif
}

void wfloat_llm_model_destroy(wfloat_llm_model_t *model) {
#if WFLOAT_ENABLE_LLAMA_CPP
  if (model) {
    llama_free(model->context);
    llama_model_free(model->model);
  }
#endif
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
  if (!model || !options || !out_result || IsNullOrEmpty(options->prompt)) {
    return WFLOAT_STATUS_INVALID_ARGUMENT;
  }

  *out_result = nullptr;

#if WFLOAT_ENABLE_LLAMA_CPP
  std::lock_guard<std::mutex> lock(model->mutex);

  try {
    llama_memory_clear(llama_get_memory(model->context), true);

    std::vector<llama_token> prompt_tokens =
        Tokenize(model->vocab, OrEmpty(options->prompt));
    if (prompt_tokens.empty()) {
      return WFLOAT_STATUS_BACKEND_ERROR;
    }

    const int32_t max_tokens =
        DefaultPositive(options->max_tokens, kDefaultMaxTokens);
    if (static_cast<int32_t>(prompt_tokens.size()) >= model->context_size ||
        static_cast<int32_t>(prompt_tokens.size()) + max_tokens >
            model->context_size) {
      return WFLOAT_STATUS_INVALID_ARGUMENT;
    }

    llama_sampler *sampler = BuildSampler(*options);
    if (!sampler) {
      return WFLOAT_STATUS_BACKEND_ERROR;
    }
    std::unique_ptr<llama_sampler, decltype(&llama_sampler_free)> sampler_guard(
        sampler, llama_sampler_free);

    llama_batch batch = llama_batch_get_one(
        prompt_tokens.data(), static_cast<int32_t>(prompt_tokens.size()));

    if (llama_model_has_encoder(model->model)) {
      if (llama_encode(model->context, batch) != 0) {
        return WFLOAT_STATUS_BACKEND_ERROR;
      }

      llama_token decoder_start_token_id =
          llama_model_decoder_start_token(model->model);
      if (decoder_start_token_id == LLAMA_TOKEN_NULL) {
        decoder_start_token_id = llama_vocab_bos(model->vocab);
      }

      batch = llama_batch_get_one(&decoder_start_token_id, 1);
    }

    auto result = std::make_unique<OwnedGenerateResult>();
    result->model_id = model->model_id;
    result->finish_reason = "length";
    result->base.prompt_token_count =
        static_cast<int32_t>(prompt_tokens.size());

    int32_t generated = 0;
    for (; generated < max_tokens; ++generated) {
      if (llama_decode(model->context, batch) != 0) {
        return WFLOAT_STATUS_BACKEND_ERROR;
      }

      llama_token token = llama_sampler_sample(sampler, model->context, -1);
      if (llama_vocab_is_eog(model->vocab, token)) {
        result->finish_reason = "stop";
        break;
      }

      std::string piece;
      if (!TokenToPiece(model->vocab, token, &piece)) {
        return WFLOAT_STATUS_BACKEND_ERROR;
      }

      result->text += piece;

      if (token_callback) {
        wfloat_llm_token_event_t event{};
        event.text = piece.c_str();
        event.token_index = generated;
        event.token_id = token;
        event.is_done = 0;
        if (token_callback(&event, user_data) != 0) {
          return WFLOAT_STATUS_CANCELLED;
        }
      }

      batch = llama_batch_get_one(&token, 1);
    }

    result->base.completion_token_count = generated;
    EmitDone(token_callback, user_data, generated);
    result->Finalize();
    *out_result = &result.release()->base;
    return WFLOAT_STATUS_OK;
  } catch (const std::exception &) {
    return WFLOAT_STATUS_BACKEND_ERROR;
  } catch (...) {
    return WFLOAT_STATUS_INTERNAL_ERROR;
  }
#else
  (void)token_callback;
  (void)user_data;
  return WFLOAT_STATUS_NOT_SUPPORTED;
#endif
}

void wfloat_llm_generate_result_destroy(wfloat_llm_generate_result_t *result) {
  delete reinterpret_cast<OwnedGenerateResult *>(result);
}

wfloat_status_t wfloat_llm_model_format_chat(
    const wfloat_llm_model_t *model,
    const wfloat_llm_chat_template_options_t *options,
    wfloat_llm_chat_template_result_t **out_result) {
  if (!model || !options || !out_result) {
    return WFLOAT_STATUS_INVALID_ARGUMENT;
  }

  *out_result = nullptr;

#if WFLOAT_ENABLE_LLAMA_CPP
  try {
    auto result = std::make_unique<OwnedChatTemplateResult>();
    wfloat_status_t status =
        FormatChatPrompt(model, options, &result->prompt,
                         &result->used_fallback);
    if (status != WFLOAT_STATUS_OK) {
      return status;
    }

    result->chat_template =
        model->chat_template.empty() ? "gguf" : model->chat_template;
    result->Finalize();
    *out_result = &result.release()->base;
    return WFLOAT_STATUS_OK;
  } catch (const std::exception &) {
    return WFLOAT_STATUS_BACKEND_ERROR;
  } catch (...) {
    return WFLOAT_STATUS_INTERNAL_ERROR;
  }
#else
  return WFLOAT_STATUS_NOT_SUPPORTED;
#endif
}

void wfloat_llm_chat_template_result_destroy(
    wfloat_llm_chat_template_result_t *result) {
  delete reinterpret_cast<OwnedChatTemplateResult *>(result);
}
