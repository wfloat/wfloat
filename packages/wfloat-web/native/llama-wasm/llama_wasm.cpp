#include <emscripten/emscripten.h>

#include <algorithm>
#include <cstdlib>
#include <cstring>
#include <exception>
#include <memory>
#include <mutex>
#include <string>
#include <vector>

#include "llama.h"

namespace {

constexpr int32_t kDefaultContextSize = 2048;
constexpr int32_t kDefaultMaxTokens = 128;

thread_local std::string g_last_error;

struct WfloatLlamaModel {
  llama_model *model = nullptr;
  llama_context *context = nullptr;
  const llama_vocab *vocab = nullptr;
  std::string chat_template;
};

typedef int32_t (*WfloatLlamaTokenCallback)(const char *text,
                                            int32_t token_index,
                                            int32_t token_id,
                                            void *user_data);

void SetError(const std::string &message) {
  g_last_error = message;
}

int32_t DefaultPositive(int32_t value, int32_t default_value) {
  return value > 0 ? value : default_value;
}

float DefaultPositive(float value, float default_value) {
  return value > 0 ? value : default_value;
}

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

char *CopyString(const std::string &value) {
  char *result = static_cast<char *>(std::malloc(value.size() + 1));
  if (!result) {
    SetError("Out of memory allocating result string.");
    return nullptr;
  }

  std::memcpy(result, value.c_str(), value.size() + 1);
  return result;
}

std::string JsonEscape(const std::string &value) {
  std::string escaped;
  escaped.reserve(value.size() + 8);

  for (unsigned char ch : value) {
    switch (ch) {
      case '"':
        escaped += "\\\"";
        break;
      case '\\':
        escaped += "\\\\";
        break;
      case '\b':
        escaped += "\\b";
        break;
      case '\f':
        escaped += "\\f";
        break;
      case '\n':
        escaped += "\\n";
        break;
      case '\r':
        escaped += "\\r";
        break;
      case '\t':
        escaped += "\\t";
        break;
      default:
        if (ch < 0x20) {
          const char *hex = "0123456789abcdef";
          escaped += "\\u00";
          escaped += hex[(ch >> 4) & 0x0f];
          escaped += hex[ch & 0x0f];
        } else {
          escaped += static_cast<char>(ch);
        }
        break;
    }
  }

  return escaped;
}

void QuietLlamaLog(ggml_log_level level, const char *text, void *user_data) {
  (void)level;
  (void)text;
  (void)user_data;
}

void InitLlamaOnce() {
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

llama_sampler *BuildSampler(float temperature, float top_p, int32_t top_k,
                            float repeat_penalty, int32_t seed) {
  llama_sampler_chain_params params = llama_sampler_chain_default_params();
  params.no_perf = true;

  llama_sampler *sampler = llama_sampler_chain_init(params);
  if (!sampler) {
    return nullptr;
  }

  const float normalized_repeat_penalty =
      DefaultPositive(repeat_penalty, 1.0f);
  if (normalized_repeat_penalty != 1.0f) {
    llama_sampler_chain_add(
        sampler,
        llama_sampler_init_penalties(64, normalized_repeat_penalty, 0.0f,
                                     0.0f));
  }

  if (temperature <= 0.0f) {
    llama_sampler_chain_add(sampler, llama_sampler_init_greedy());
    return sampler;
  }

  llama_sampler_chain_add(sampler, llama_sampler_init_top_k(top_k));
  llama_sampler_chain_add(
      sampler, llama_sampler_init_top_p(DefaultPositive(top_p, 0.95f), 1));
  llama_sampler_chain_add(
      sampler, llama_sampler_init_temp(DefaultPositive(temperature, 0.8f)));
  llama_sampler_chain_add(
      sampler, llama_sampler_init_dist(static_cast<uint32_t>(seed)));
  return sampler;
}

bool FormatChatPrompt(WfloatLlamaModel *handle, const char **roles,
                      const char **contents, int32_t message_count,
                      int32_t add_generation_prompt,
                      int32_t chat_template_format,
                      std::string *out_prompt,
                      bool *out_used_fallback) {
  if (!handle || !roles || !contents || !out_prompt || !out_used_fallback ||
      message_count <= 0) {
    SetError("Invalid chat formatting arguments.");
    return false;
  }

  *out_used_fallback = false;

  std::vector<llama_chat_message> messages;
  messages.reserve(static_cast<size_t>(message_count));

  for (int32_t i = 0; i < message_count; ++i) {
    if (!roles[i] || roles[i][0] == '\0' || !contents[i] ||
        contents[i][0] == '\0') {
      SetError("Chat messages must have non-empty role and content strings.");
      return false;
    }

    messages.push_back(llama_chat_message{roles[i], contents[i]});
  }

  if (chat_template_format == 1) {
    FormatChatMlPrompt(messages, add_generation_prompt, out_prompt);
    return true;
  }

  const char *tmpl =
      handle->chat_template.empty() ? nullptr : handle->chat_template.c_str();
  int32_t required = -1;
  try {
    required = llama_chat_apply_template(
        tmpl, messages.data(), messages.size(), add_generation_prompt != 0,
        nullptr, 0);
  } catch (...) {
    required = -1;
  }

  if (required > 0) {
    std::vector<char> buffer(static_cast<size_t>(required) + 1, '\0');
    int32_t written = -1;
    try {
      written = llama_chat_apply_template(
          tmpl, messages.data(), messages.size(), add_generation_prompt != 0,
          buffer.data(), static_cast<int32_t>(buffer.size()));
    } catch (...) {
      written = -1;
    }

    if (written >= 0) {
      out_prompt->assign(buffer.data(), static_cast<size_t>(written));
      return true;
    }
  }

  SetError("llama.cpp could not apply the GGUF chat template for this model. "
           "If the model uses a known prompt format, declare it in the model "
           "asset manifest instead of relying on fallback formatting.");
  return false;
}

}  // namespace

extern "C" {

EMSCRIPTEN_KEEPALIVE
const char *wfloat_llama_last_error() {
  return g_last_error.c_str();
}

EMSCRIPTEN_KEEPALIVE
void wfloat_llama_free_string(char *value) {
  std::free(value);
}

EMSCRIPTEN_KEEPALIVE
int32_t wfloat_llama_model_create(const char *model_path, int32_t context_size,
                                  int32_t num_threads,
                                  WfloatLlamaModel **out_handle) {
  if (!model_path || model_path[0] == '\0' || !out_handle) {
    SetError("model_path and out_handle are required.");
    return 1;
  }

  *out_handle = nullptr;

  try {
    InitLlamaOnce();

    llama_model_params model_params = llama_model_default_params();
    llama_model *model = llama_model_load_from_file(model_path, model_params);
    if (!model) {
      SetError("llama.cpp failed to load the GGUF model.");
      return 2;
    }

    llama_context_params context_params = llama_context_default_params();
    context_params.n_ctx =
        static_cast<uint32_t>(DefaultPositive(context_size, kDefaultContextSize));
    context_params.n_batch = context_params.n_ctx;
    context_params.n_threads = DefaultPositive(num_threads, 1);
    context_params.n_threads_batch = context_params.n_threads;
    context_params.no_perf = true;

    llama_context *context = llama_init_from_model(model, context_params);
    if (!context) {
      llama_model_free(model);
      SetError("llama.cpp failed to initialize model context.");
      return 3;
    }

    std::unique_ptr<WfloatLlamaModel> handle(new WfloatLlamaModel());
    handle->model = model;
    handle->context = context;
    handle->vocab = llama_model_get_vocab(model);
    const char *chat_template = llama_model_chat_template(model, nullptr);
    if (chat_template) {
      handle->chat_template = chat_template;
    }

    *out_handle = handle.release();
    return 0;
  } catch (const std::exception &e) {
    SetError(e.what());
    return 4;
  } catch (...) {
    SetError("Unknown exception loading llama.cpp model.");
    return 5;
  }
}

EMSCRIPTEN_KEEPALIVE
void wfloat_llama_model_destroy(WfloatLlamaModel *handle) {
  if (!handle) {
    return;
  }
  llama_free(handle->context);
  llama_model_free(handle->model);
  delete handle;
}

EMSCRIPTEN_KEEPALIVE
char *wfloat_llama_model_format_chat(WfloatLlamaModel *handle,
                                     const char **roles,
                                     const char **contents,
                                     int32_t message_count,
                                     int32_t add_generation_prompt,
                                     int32_t chat_template_format,
                                     int32_t *out_used_fallback) {
  bool used_fallback = false;
  std::string prompt;
  if (!FormatChatPrompt(handle, roles, contents, message_count,
                        add_generation_prompt, chat_template_format, &prompt,
                        &used_fallback)) {
    return nullptr;
  }

  if (out_used_fallback) {
    *out_used_fallback = used_fallback ? 1 : 0;
  }

  return CopyString(prompt);
}

EMSCRIPTEN_KEEPALIVE
char *wfloat_llama_model_generate_json(WfloatLlamaModel *handle,
                                       const char *prompt,
                                       int32_t max_tokens,
                                       float temperature,
                                       float top_p,
                                       int32_t top_k,
                                       float repeat_penalty,
                                       int32_t seed,
                                       WfloatLlamaTokenCallback token_callback,
                                       void *user_data) {
  if (!handle || !prompt || prompt[0] == '\0') {
    SetError("A loaded model and non-empty prompt are required.");
    return nullptr;
  }

  try {
    llama_memory_clear(llama_get_memory(handle->context), true);

    std::vector<llama_token> prompt_tokens = Tokenize(handle->vocab, prompt);
    if (prompt_tokens.empty()) {
      SetError("Failed to tokenize prompt.");
      return nullptr;
    }

    const int32_t normalized_max_tokens =
        DefaultPositive(max_tokens, kDefaultMaxTokens);
    const int32_t context_size = static_cast<int32_t>(llama_n_ctx(handle->context));
    if (static_cast<int32_t>(prompt_tokens.size()) >= context_size ||
        static_cast<int32_t>(prompt_tokens.size()) + normalized_max_tokens >
            context_size) {
      SetError("Prompt and max_tokens exceed the model context window.");
      return nullptr;
    }

    llama_sampler *sampler =
        BuildSampler(temperature, top_p, top_k, repeat_penalty, seed);
    if (!sampler) {
      SetError("Failed to initialize sampler.");
      return nullptr;
    }
    std::unique_ptr<llama_sampler, decltype(&llama_sampler_free)> sampler_guard(
        sampler, llama_sampler_free);

    llama_batch batch = llama_batch_get_one(
        prompt_tokens.data(), static_cast<int32_t>(prompt_tokens.size()));
    if (llama_model_has_encoder(handle->model)) {
      if (llama_encode(handle->context, batch) != 0) {
        SetError("llama_encode failed.");
        return nullptr;
      }

      llama_token decoder_start_token_id =
          llama_model_decoder_start_token(handle->model);
      if (decoder_start_token_id == LLAMA_TOKEN_NULL) {
        decoder_start_token_id = llama_vocab_bos(handle->vocab);
      }
      batch = llama_batch_get_one(&decoder_start_token_id, 1);
    }

    std::string text;
    std::string finish_reason = "length";
    int32_t generated = 0;

    for (; generated < normalized_max_tokens; ++generated) {
      if (llama_decode(handle->context, batch) != 0) {
        SetError("llama_decode failed.");
        return nullptr;
      }

      llama_token token = llama_sampler_sample(sampler, handle->context, -1);
      if (llama_vocab_is_eog(handle->vocab, token)) {
        finish_reason = "stop";
        break;
      }

      std::string piece;
      if (!TokenToPiece(handle->vocab, token, &piece)) {
        SetError("Failed to decode generated token.");
        return nullptr;
      }

      text += piece;
      if (token_callback &&
          token_callback(piece.c_str(), generated, token, user_data) == 0) {
        finish_reason = "cancelled";
        break;
      }
      batch = llama_batch_get_one(&token, 1);
    }

    if (token_callback) {
      token_callback("", generated, -1, user_data);
    }

    std::string json = "{";
    json += "\"text\":\"" + JsonEscape(text) + "\",";
    json += "\"finishReason\":\"" + JsonEscape(finish_reason) + "\",";
    json += "\"promptTokenCount\":" +
            std::to_string(static_cast<int32_t>(prompt_tokens.size())) + ",";
    json += "\"completionTokenCount\":" + std::to_string(generated);
    json += "}";
    return CopyString(json);
  } catch (const std::exception &e) {
    SetError(e.what());
    return nullptr;
  } catch (...) {
    SetError("Unknown exception during llama.cpp generation.");
    return nullptr;
  }
}

}  // extern "C"
