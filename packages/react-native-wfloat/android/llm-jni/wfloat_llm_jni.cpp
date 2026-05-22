#include <jni.h>

#include <cstdint>
#include <sstream>
#include <string>
#include <vector>

#include "wfloat-core/wfloat_llm.h"

namespace {

std::string JStringToString(JNIEnv *env, jstring value) {
  if (!value) {
    return "";
  }

  const char *chars = env->GetStringUTFChars(value, nullptr);
  if (!chars) {
    return "";
  }

  std::string result(chars);
  env->ReleaseStringUTFChars(value, chars);
  return result;
}

jstring StringToJString(JNIEnv *env, const std::string &value) {
  return env->NewStringUTF(value.c_str());
}

void ThrowRuntimeException(JNIEnv *env, const std::string &message) {
  jclass exception_class = env->FindClass("java/lang/RuntimeException");
  if (exception_class) {
    env->ThrowNew(exception_class, message.c_str());
  }
}

const char *StatusName(wfloat_status_t status) {
  switch (status) {
    case WFLOAT_STATUS_OK:
      return "ok";
    case WFLOAT_STATUS_INVALID_ARGUMENT:
      return "invalid argument";
    case WFLOAT_STATUS_NOT_SUPPORTED:
      return "not supported";
    case WFLOAT_STATUS_BACKEND_ERROR:
      return "backend error";
    case WFLOAT_STATUS_CANCELLED:
      return "cancelled";
    case WFLOAT_STATUS_INTERNAL_ERROR:
      return "internal error";
    default:
      return "unknown error";
  }
}

wfloat_llm_family_t FamilyFromString(const std::string &family) {
  if (family == "llama") {
    return WFLOAT_LLM_FAMILY_LLAMA;
  }
  if (family == "qwen") {
    return WFLOAT_LLM_FAMILY_QWEN;
  }
  if (family == "smollm" || family == "smol-lm") {
    return WFLOAT_LLM_FAMILY_SMOLLM;
  }
  if (family == "gemma") {
    return WFLOAT_LLM_FAMILY_GEMMA;
  }
  if (family == "mistral") {
    return WFLOAT_LLM_FAMILY_MISTRAL;
  }
  if (family == "phi") {
    return WFLOAT_LLM_FAMILY_PHI;
  }
  if (family == "liquid") {
    return WFLOAT_LLM_FAMILY_LIQUID;
  }

  return WFLOAT_LLM_FAMILY_UNKNOWN;
}

std::string JsonEscape(const char *value) {
  std::string input = value ? value : "";
  std::ostringstream escaped;

  for (char ch : input) {
    switch (ch) {
      case '\\':
        escaped << "\\\\";
        break;
      case '"':
        escaped << "\\\"";
        break;
      case '\n':
        escaped << "\\n";
        break;
      case '\r':
        escaped << "\\r";
        break;
      case '\t':
        escaped << "\\t";
        break;
      default:
        if (static_cast<unsigned char>(ch) < 0x20) {
          escaped << "\\u00";
          const char *hex = "0123456789abcdef";
          escaped << hex[(ch >> 4) & 0x0f] << hex[ch & 0x0f];
        } else {
          escaped << ch;
        }
        break;
    }
  }

  return escaped.str();
}

std::string GenerationResultToJson(const wfloat_llm_generate_result_t *result) {
  std::ostringstream json;
  json << "{";
  json << "\"text\":\"" << JsonEscape(result ? result->text : "") << "\",";
  json << "\"modelId\":\"" << JsonEscape(result ? result->model_id : "") << "\",";
  json << "\"finishReason\":\""
       << JsonEscape(result ? result->finish_reason : "") << "\",";
  json << "\"promptTokenCount\":"
       << (result ? result->prompt_token_count : 0) << ",";
  json << "\"completionTokenCount\":"
       << (result ? result->completion_token_count : 0) << ",";
  json << "\"json\":\"" << JsonEscape(result ? result->json : "") << "\"";
  json << "}";
  return json.str();
}

wfloat_llm_generate_options_t BuildGenerateOptions(
    const std::string &prompt, jint max_tokens, jfloat temperature,
    jfloat top_p, jint top_k, jfloat repeat_penalty, jint seed) {
  wfloat_llm_generate_options_t options{};
  options.prompt = prompt.c_str();
  options.max_tokens = max_tokens;
  options.temperature = temperature;
  options.top_p = top_p;
  options.top_k = top_k;
  options.repeat_penalty = repeat_penalty;
  options.seed = seed;
  return options;
}

struct TokenCallbackContext {
  JNIEnv *env;
  jobject target;
  jmethodID method;
  jint request_id;
};

int32_t TokenCallback(const wfloat_llm_token_event_t *event, void *user_data) {
  if (!event || !user_data) {
    return 0;
  }

  auto *context = reinterpret_cast<TokenCallbackContext *>(user_data);
  jstring text = StringToJString(context->env, event->text ? event->text : "");
  context->env->CallVoidMethod(
      context->target,
      context->method,
      context->request_id,
      text,
      static_cast<jint>(event->token_index),
      static_cast<jint>(event->token_id),
      event->is_done != 0 ? JNI_TRUE : JNI_FALSE);
  context->env->DeleteLocalRef(text);

  return context->env->ExceptionCheck() ? 1 : 0;
}

wfloat_llm_model_t *ModelFromHandle(jlong handle) {
  return reinterpret_cast<wfloat_llm_model_t *>(static_cast<intptr_t>(handle));
}

jlong HandleFromModel(wfloat_llm_model_t *model) {
  return static_cast<jlong>(reinterpret_cast<intptr_t>(model));
}

jmethodID GetTokenMethod(JNIEnv *env, jobject callback_target) {
  jclass target_class = env->GetObjectClass(callback_target);
  if (!target_class) {
    return nullptr;
  }

  return env->GetMethodID(
      target_class,
      "emitLlmTokenFromNative",
      "(ILjava/lang/String;IIZ)V");
}

}  // namespace

extern "C" JNIEXPORT jlong JNICALL
Java_com_wfloat_WfloatLlmNative_load(
    JNIEnv *env,
    jobject,
    jstring model_id,
    jstring family,
    jstring model_path,
    jstring chat_template,
    jint context_size,
    jint num_threads,
    jint gpu_layer_count) {
  std::string model_id_value = JStringToString(env, model_id);
  std::string family_value = JStringToString(env, family);
  std::string model_path_value = JStringToString(env, model_path);
  std::string chat_template_value = JStringToString(env, chat_template);

  wfloat_llm_family_t llm_family = FamilyFromString(family_value);
  if (llm_family == WFLOAT_LLM_FAMILY_UNKNOWN) {
    ThrowRuntimeException(env, "Unsupported LLM family: " + family_value);
    return 0;
  }

  wfloat_llm_model_config_t config{};
  config.model_id = model_id_value.c_str();
  config.family = llm_family;
  config.model_path = model_path_value.c_str();
  config.chat_template = chat_template_value.c_str();
  config.context_size = context_size;
  config.num_threads = num_threads;
  config.gpu_layer_count = gpu_layer_count;
  config.seed = 0;

  wfloat_llm_model_t *model = nullptr;
  wfloat_status_t status = wfloat_llm_model_create(&config, &model);
  if (status != WFLOAT_STATUS_OK || !model) {
    ThrowRuntimeException(
        env,
        std::string("LLM model load failed: ") + StatusName(status));
    return 0;
  }

  return HandleFromModel(model);
}

extern "C" JNIEXPORT void JNICALL
Java_com_wfloat_WfloatLlmNative_destroy(JNIEnv *, jobject, jlong handle) {
  wfloat_llm_model_destroy(ModelFromHandle(handle));
}

extern "C" JNIEXPORT jstring JNICALL
Java_com_wfloat_WfloatLlmNative_generate(
    JNIEnv *env,
    jobject,
    jlong handle,
    jint request_id,
    jstring prompt,
    jint max_tokens,
    jfloat temperature,
    jfloat top_p,
    jint top_k,
    jfloat repeat_penalty,
    jint seed,
    jobject callback_target) {
  wfloat_llm_model_t *model = ModelFromHandle(handle);
  if (!model) {
    ThrowRuntimeException(env, "LLM model is not loaded.");
    return nullptr;
  }

  jmethodID token_method = GetTokenMethod(env, callback_target);
  if (!token_method) {
    ThrowRuntimeException(env, "Could not resolve LLM token callback.");
    return nullptr;
  }

  std::string prompt_value = JStringToString(env, prompt);
  wfloat_llm_generate_options_t options = BuildGenerateOptions(
      prompt_value, max_tokens, temperature, top_p, top_k, repeat_penalty, seed);
  TokenCallbackContext callback_context{env, callback_target, token_method,
                                        request_id};
  wfloat_llm_generate_result_t *result = nullptr;
  wfloat_status_t status = wfloat_llm_model_generate(
      model, &options, TokenCallback, &callback_context, &result);
  if (status != WFLOAT_STATUS_OK || !result) {
    ThrowRuntimeException(
        env,
        std::string("LLM generate failed: ") + StatusName(status));
    return nullptr;
  }

  std::string json = GenerationResultToJson(result);
  wfloat_llm_generate_result_destroy(result);
  return StringToJString(env, json);
}

extern "C" JNIEXPORT jstring JNICALL
Java_com_wfloat_WfloatLlmNative_chat(
    JNIEnv *env,
    jobject,
    jlong handle,
    jint request_id,
    jobjectArray roles,
    jobjectArray contents,
    jboolean add_generation_prompt,
    jint max_tokens,
    jfloat temperature,
    jfloat top_p,
    jint top_k,
    jfloat repeat_penalty,
    jint seed,
    jobject callback_target) {
  wfloat_llm_model_t *model = ModelFromHandle(handle);
  if (!model) {
    ThrowRuntimeException(env, "LLM model is not loaded.");
    return nullptr;
  }

  jsize message_count = roles ? env->GetArrayLength(roles) : 0;
  if (!roles || !contents || message_count <= 0 ||
      env->GetArrayLength(contents) != message_count) {
    ThrowRuntimeException(env, "messages must contain at least one chat message.");
    return nullptr;
  }

  std::vector<std::string> role_values;
  std::vector<std::string> content_values;
  std::vector<wfloat_llm_chat_message_t> messages;
  role_values.reserve(message_count);
  content_values.reserve(message_count);
  messages.reserve(message_count);

  for (jsize index = 0; index < message_count; ++index) {
    auto role = static_cast<jstring>(env->GetObjectArrayElement(roles, index));
    auto content =
        static_cast<jstring>(env->GetObjectArrayElement(contents, index));
    role_values.push_back(JStringToString(env, role));
    content_values.push_back(JStringToString(env, content));
    env->DeleteLocalRef(role);
    env->DeleteLocalRef(content);

    wfloat_llm_chat_message_t message{};
    message.role = role_values.back().c_str();
    message.content = content_values.back().c_str();
    messages.push_back(message);
  }

  wfloat_llm_chat_template_options_t template_options{};
  template_options.messages = messages.data();
  template_options.message_count = messages.size();
  template_options.add_generation_prompt =
      add_generation_prompt == JNI_TRUE ? 1 : 0;

  wfloat_llm_chat_template_result_t *template_result = nullptr;
  wfloat_status_t status =
      wfloat_llm_model_format_chat(model, &template_options, &template_result);
  if (status != WFLOAT_STATUS_OK || !template_result ||
      !template_result->prompt) {
    ThrowRuntimeException(
        env,
        std::string("LLM chat formatting failed: ") + StatusName(status));
    return nullptr;
  }

  std::string prompt_value = template_result->prompt;
  wfloat_llm_chat_template_result_destroy(template_result);

  jmethodID token_method = GetTokenMethod(env, callback_target);
  if (!token_method) {
    ThrowRuntimeException(env, "Could not resolve LLM token callback.");
    return nullptr;
  }

  wfloat_llm_generate_options_t options = BuildGenerateOptions(
      prompt_value, max_tokens, temperature, top_p, top_k, repeat_penalty, seed);
  TokenCallbackContext callback_context{env, callback_target, token_method,
                                        request_id};
  wfloat_llm_generate_result_t *result = nullptr;
  status = wfloat_llm_model_generate(
      model, &options, TokenCallback, &callback_context, &result);
  if (status != WFLOAT_STATUS_OK || !result) {
    ThrowRuntimeException(
        env,
        std::string("LLM chat failed: ") + StatusName(status));
    return nullptr;
  }

  std::string json = GenerationResultToJson(result);
  wfloat_llm_generate_result_destroy(result);
  return StringToJString(env, json);
}
