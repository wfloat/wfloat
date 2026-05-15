#include "wfloat-core/wfloat_stt.h"

#include <math.h>
#include <stddef.h>
#include <stdint.h>
#include <string.h>

#include <memory>
#include <string>
#include <utility>
#include <vector>

#include "sherpa-onnx/c-api/c-api.h"

struct StoredSttConfig {
  std::string model_id;
  wfloat_stt_family_t family = WFLOAT_STT_FAMILY_UNKNOWN;

  std::string model_path;
  std::string tokens_path;
  std::string preprocessor_path;
  std::string encoder_path;
  std::string decoder_path;
  std::string joiner_path;
  std::string uncached_decoder_path;
  std::string cached_decoder_path;
  std::string provider;

  std::string language;
  std::string task;
  std::string hotwords_file;
  std::string rule_fsts;
  std::string rule_fars;

  int32_t sample_rate = 16000;
  int32_t feat_dim = 80;
  int32_t num_threads = 1;
  int32_t debug = 0;
  int32_t max_active_paths = 4;
  int32_t tail_paddings = 0;
  int32_t enable_token_timestamps = 0;
  int32_t enable_segment_timestamps = 0;

  float hotwords_score = 1.5f;
  float blank_penalty = 0.0f;
};

struct wfloat_stt_model {
  StoredSttConfig config;
  std::string backend = "sherpa-onnx";
  std::string family_name;
  uint64_t feature_flags = WFLOAT_STT_FEATURE_NONE;
  int32_t sample_rate = 16000;
  int32_t supports_language_override = 0;
  const SherpaOnnxOfflineRecognizer *recognizer = nullptr;
  const SherpaOnnxOnlineRecognizer *online_recognizer = nullptr;
  size_t active_session_count = 0;
  bool destroy_pending = false;
};

struct wfloat_stt_session {
  wfloat_stt_model_t *model = nullptr;
  const SherpaOnnxOnlineStream *stream = nullptr;
};

namespace {

constexpr int32_t kStatusOk = 0;
constexpr int32_t kStatusInvalidArgument = 1;
constexpr int32_t kStatusNotSupported = 2;
constexpr int32_t kStatusBackendError = 4;
constexpr int32_t kStatusInternalError = 5;

constexpr int32_t kDefaultSampleRate = 16000;
constexpr int32_t kDefaultFeatureDim = 80;
constexpr int32_t kDefaultThreads = 1;
constexpr int32_t kDefaultMaxActivePaths = 4;
constexpr float kDefaultEndpointRule1MinTrailingSilence = 2.4f;
constexpr float kDefaultEndpointRule2MinTrailingSilence = 1.2f;
constexpr float kDefaultEndpointRule3MinUtteranceLength = 20.0f;

struct OwnedTranscriptionResult {
  wfloat_stt_transcription_result_t base{};

  std::string model_id;
  std::string text;
  std::string language;
  std::string emotion;
  std::string event;
  std::string json;

  std::vector<wfloat_stt_token_t> tokens;
  std::vector<std::string> token_text_storage;

  std::vector<wfloat_stt_segment_t> segments;
  std::vector<std::string> segment_text_storage;

  void Finalize() {
    for (size_t i = 0; i < tokens.size(); ++i) {
      tokens[i].text = token_text_storage[i].c_str();
    }
    for (size_t i = 0; i < segments.size(); ++i) {
      segments[i].text = segment_text_storage[i].c_str();
    }

    base.model_id = model_id.c_str();
    base.text = text.c_str();
    base.language = language.empty() ? nullptr : language.c_str();
    base.emotion = emotion.empty() ? nullptr : emotion.c_str();
    base.event = event.empty() ? nullptr : event.c_str();
    base.json = json.empty() ? nullptr : json.c_str();
    base.tokens = tokens.empty() ? nullptr : tokens.data();
    base.token_count = tokens.size();
    base.segments = segments.empty() ? nullptr : segments.data();
    base.segment_count = segments.size();
  }
};

struct OwnedSessionResult {
  wfloat_stt_session_result_t base{};
  std::string model_id;
  std::string text;
  std::string json;
  int32_t is_endpoint = 0;

  void Finalize() {
    base.model_id = model_id.c_str();
    base.text = text.c_str();
    base.json = json.empty() ? nullptr : json.c_str();
    base.is_endpoint = is_endpoint;
  }
};

std::string OrEmpty(const char *value) {
  return value ? std::string(value) : std::string();
}

bool IsNullOrEmpty(const char *value) {
  return value == nullptr || *value == '\0';
}

int32_t DefaultPositiveInt(int32_t value, int32_t fallback) {
  return value > 0 ? value : fallback;
}

float DefaultNonNegativeFloat(float value, float fallback) {
  return value >= 0.0f ? value : fallback;
}

const char *FamilyName(wfloat_stt_family_t family) {
  switch (family) {
    case WFLOAT_STT_FAMILY_WHISPER:
      return "whisper";
    case WFLOAT_STT_FAMILY_MOONSHINE:
      return "moonshine";
    case WFLOAT_STT_FAMILY_PARAKEET_CTC:
      return "parakeet-ctc";
    case WFLOAT_STT_FAMILY_PARAKEET_TDT:
      return "parakeet-tdt";
    case WFLOAT_STT_FAMILY_ZIPFORMER_TRANSDUCER:
      return "zipformer-transducer";
    case WFLOAT_STT_FAMILY_UNKNOWN:
    default:
      return "unknown";
  }
}

uint64_t FeatureFlagsForConfig(const StoredSttConfig &config) {
  uint64_t flags = WFLOAT_STT_FEATURE_TOKENS;

  switch (config.family) {
    case WFLOAT_STT_FAMILY_WHISPER:
      flags |= WFLOAT_STT_FEATURE_LANGUAGE;
      if (config.enable_token_timestamps) {
        flags |= WFLOAT_STT_FEATURE_TIMESTAMPS;
      }
      if (config.enable_segment_timestamps) {
        flags |= WFLOAT_STT_FEATURE_SEGMENTS;
      }
      break;
    case WFLOAT_STT_FAMILY_MOONSHINE:
      break;
    case WFLOAT_STT_FAMILY_PARAKEET_CTC:
      break;
    case WFLOAT_STT_FAMILY_PARAKEET_TDT:
      flags |= WFLOAT_STT_FEATURE_TIMESTAMPS;
      flags |= WFLOAT_STT_FEATURE_DURATIONS;
      break;
    case WFLOAT_STT_FAMILY_ZIPFORMER_TRANSDUCER:
      flags |= WFLOAT_STT_FEATURE_TIMESTAMPS;
      flags |= WFLOAT_STT_FEATURE_EVENTS;
      flags |= WFLOAT_STT_FEATURE_STREAMING;
      break;
    case WFLOAT_STT_FAMILY_UNKNOWN:
    default:
      break;
  }

  return flags;
}

int32_t ValidateConfig(const StoredSttConfig &config) {
  if (config.family == WFLOAT_STT_FAMILY_UNKNOWN ||
      config.model_id.empty() ||
      config.tokens_path.empty()) {
    return kStatusInvalidArgument;
  }

  switch (config.family) {
    case WFLOAT_STT_FAMILY_WHISPER:
      if (config.encoder_path.empty() || config.decoder_path.empty()) {
        return kStatusInvalidArgument;
      }
      break;
    case WFLOAT_STT_FAMILY_MOONSHINE:
      if (config.preprocessor_path.empty() || config.encoder_path.empty() ||
          config.uncached_decoder_path.empty() ||
          config.cached_decoder_path.empty()) {
        return kStatusInvalidArgument;
      }
      break;
    case WFLOAT_STT_FAMILY_PARAKEET_CTC:
      if (config.model_path.empty()) {
        return kStatusInvalidArgument;
      }
      break;
    case WFLOAT_STT_FAMILY_PARAKEET_TDT:
      if (config.encoder_path.empty() || config.decoder_path.empty() ||
          config.joiner_path.empty()) {
        return kStatusInvalidArgument;
      }
      break;
    case WFLOAT_STT_FAMILY_ZIPFORMER_TRANSDUCER:
      if (config.encoder_path.empty() || config.decoder_path.empty() ||
          config.joiner_path.empty()) {
        return kStatusInvalidArgument;
      }
      break;
    case WFLOAT_STT_FAMILY_UNKNOWN:
    default:
      return kStatusNotSupported;
  }

  return kStatusOk;
}

StoredSttConfig CopyConfig(const wfloat_stt_model_config_t *config) {
  StoredSttConfig out;
  out.model_id = OrEmpty(config->model_id);
  out.family = config->family;
  out.model_path = OrEmpty(config->model_path);
  out.tokens_path = OrEmpty(config->tokens_path);
  out.preprocessor_path = OrEmpty(config->preprocessor_path);
  out.encoder_path = OrEmpty(config->encoder_path);
  out.decoder_path = OrEmpty(config->decoder_path);
  out.joiner_path = OrEmpty(config->joiner_path);
  out.uncached_decoder_path = OrEmpty(config->uncached_decoder_path);
  out.cached_decoder_path = OrEmpty(config->cached_decoder_path);
  out.provider = IsNullOrEmpty(config->provider) ? "cpu" : config->provider;
  out.language = OrEmpty(config->language);
  out.task = OrEmpty(config->task);
  out.hotwords_file = OrEmpty(config->hotwords_file);
  out.rule_fsts = OrEmpty(config->rule_fsts);
  out.rule_fars = OrEmpty(config->rule_fars);
  out.sample_rate = DefaultPositiveInt(config->sample_rate, kDefaultSampleRate);
  out.feat_dim = DefaultPositiveInt(config->feat_dim, kDefaultFeatureDim);
  out.num_threads = DefaultPositiveInt(config->num_threads, kDefaultThreads);
  out.debug = config->debug != 0;
  out.max_active_paths =
      DefaultPositiveInt(config->max_active_paths, kDefaultMaxActivePaths);
  out.tail_paddings = config->tail_paddings;
  out.enable_token_timestamps = config->enable_token_timestamps != 0;
  out.enable_segment_timestamps = config->enable_segment_timestamps != 0;
  out.hotwords_score = DefaultNonNegativeFloat(config->hotwords_score, 1.5f);
  out.blank_penalty = config->blank_penalty;
  return out;
}

SherpaOnnxOfflineRecognizerConfig BuildRecognizerConfig(
    const StoredSttConfig &config, const char *override_language,
    const char *override_task) {
  SherpaOnnxOfflineRecognizerConfig recognizer_config;
  memset(&recognizer_config, 0, sizeof(recognizer_config));

  recognizer_config.feat_config.sample_rate = config.sample_rate;
  recognizer_config.feat_config.feature_dim = config.feat_dim;

  recognizer_config.model_config.tokens = config.tokens_path.c_str();
  recognizer_config.model_config.num_threads = config.num_threads;
  recognizer_config.model_config.debug = config.debug;
  recognizer_config.model_config.provider = config.provider.c_str();

  switch (config.family) {
    case WFLOAT_STT_FAMILY_WHISPER:
      recognizer_config.model_config.whisper.encoder =
          config.encoder_path.c_str();
      recognizer_config.model_config.whisper.decoder =
          config.decoder_path.c_str();
      recognizer_config.model_config.whisper.language =
          IsNullOrEmpty(override_language) ? config.language.c_str()
                                           : override_language;
      recognizer_config.model_config.whisper.task =
          IsNullOrEmpty(override_task) ? config.task.c_str() : override_task;
      recognizer_config.model_config.whisper.tail_paddings =
          config.tail_paddings;
      recognizer_config.model_config.whisper.enable_token_timestamps =
          config.enable_token_timestamps;
      recognizer_config.model_config.whisper.enable_segment_timestamps =
          config.enable_segment_timestamps;
      break;
    case WFLOAT_STT_FAMILY_MOONSHINE:
      recognizer_config.model_config.moonshine.preprocessor =
          config.preprocessor_path.c_str();
      recognizer_config.model_config.moonshine.encoder =
          config.encoder_path.c_str();
      recognizer_config.model_config.moonshine.uncached_decoder =
          config.uncached_decoder_path.c_str();
      recognizer_config.model_config.moonshine.cached_decoder =
          config.cached_decoder_path.c_str();
      break;
    case WFLOAT_STT_FAMILY_PARAKEET_CTC:
      recognizer_config.model_config.nemo_ctc.model =
          config.model_path.c_str();
      break;
    case WFLOAT_STT_FAMILY_PARAKEET_TDT:
      recognizer_config.model_config.transducer.encoder =
          config.encoder_path.c_str();
      recognizer_config.model_config.transducer.decoder =
          config.decoder_path.c_str();
      recognizer_config.model_config.transducer.joiner =
          config.joiner_path.c_str();
      break;
    case WFLOAT_STT_FAMILY_ZIPFORMER_TRANSDUCER:
    case WFLOAT_STT_FAMILY_UNKNOWN:
    default:
      break;
  }

  recognizer_config.decoding_method = "greedy_search";
  recognizer_config.max_active_paths = config.max_active_paths;
  recognizer_config.hotwords_file = config.hotwords_file.c_str();
  recognizer_config.hotwords_score = config.hotwords_score;
  recognizer_config.rule_fsts = config.rule_fsts.c_str();
  recognizer_config.rule_fars = config.rule_fars.c_str();
  recognizer_config.blank_penalty = config.blank_penalty;
  return recognizer_config;
}

SherpaOnnxOnlineRecognizerConfig BuildOnlineRecognizerConfig(
    const StoredSttConfig &config) {
  SherpaOnnxOnlineRecognizerConfig recognizer_config;
  memset(&recognizer_config, 0, sizeof(recognizer_config));

  recognizer_config.feat_config.sample_rate = config.sample_rate;
  recognizer_config.feat_config.feature_dim = config.feat_dim;

  recognizer_config.model_config.tokens = config.tokens_path.c_str();
  recognizer_config.model_config.num_threads = config.num_threads;
  recognizer_config.model_config.provider = config.provider.c_str();
  recognizer_config.model_config.debug = config.debug;
  recognizer_config.model_config.model_type = "";
  recognizer_config.model_config.modeling_unit = "cjkchar";
  recognizer_config.model_config.bpe_vocab = "";
  recognizer_config.model_config.tokens_buf = "";
  recognizer_config.model_config.tokens_buf_size = 0;
  recognizer_config.model_config.nemo_ctc.model = "";
  recognizer_config.model_config.t_one_ctc.model = "";

  switch (config.family) {
    case WFLOAT_STT_FAMILY_ZIPFORMER_TRANSDUCER:
      recognizer_config.model_config.transducer.encoder =
          config.encoder_path.c_str();
      recognizer_config.model_config.transducer.decoder =
          config.decoder_path.c_str();
      recognizer_config.model_config.transducer.joiner =
          config.joiner_path.c_str();
      break;
    case WFLOAT_STT_FAMILY_UNKNOWN:
    case WFLOAT_STT_FAMILY_WHISPER:
    case WFLOAT_STT_FAMILY_MOONSHINE:
    case WFLOAT_STT_FAMILY_PARAKEET_CTC:
    case WFLOAT_STT_FAMILY_PARAKEET_TDT:
    default:
      break;
  }

  recognizer_config.decoding_method = "greedy_search";
  recognizer_config.max_active_paths = config.max_active_paths;
  recognizer_config.enable_endpoint = 1;
  recognizer_config.rule1_min_trailing_silence =
      kDefaultEndpointRule1MinTrailingSilence;
  recognizer_config.rule2_min_trailing_silence =
      kDefaultEndpointRule2MinTrailingSilence;
  recognizer_config.rule3_min_utterance_length =
      kDefaultEndpointRule3MinUtteranceLength;
  recognizer_config.hotwords_file = config.hotwords_file.c_str();
  recognizer_config.hotwords_score = config.hotwords_score;
  recognizer_config.ctc_fst_decoder_config.graph = "";
  recognizer_config.ctc_fst_decoder_config.max_active = 3000;
  recognizer_config.rule_fsts = config.rule_fsts.c_str();
  recognizer_config.rule_fars = config.rule_fars.c_str();
  recognizer_config.blank_penalty = config.blank_penalty;
  recognizer_config.hotwords_buf = "";
  recognizer_config.hotwords_buf_size = 0;
  recognizer_config.hr.dict_dir = "";
  recognizer_config.hr.lexicon = "";
  recognizer_config.hr.rule_fsts = "";

  return recognizer_config;
}

int32_t SetRecognizerConfig(wfloat_stt_model_t *model, const char *language,
                            const char *task) {
  if (!model->recognizer) {
    return kStatusNotSupported;
  }

  SherpaOnnxOfflineRecognizerConfig config =
      BuildRecognizerConfig(model->config, language, task);
  SherpaOnnxOfflineRecognizerSetConfig(model->recognizer, &config);
  return kStatusOk;
}

int32_t PopulateResult(const wfloat_stt_model_t *model,
                       const SherpaOnnxOfflineRecognizerResult *result,
                       OwnedTranscriptionResult *out) {
  if (!model || !result || !out) {
    return kStatusInvalidArgument;
  }

  out->model_id = model->config.model_id;
  out->text = result->text ? result->text : "";
  out->language = result->lang ? result->lang : "";
  out->emotion = result->emotion ? result->emotion : "";
  out->event = result->event ? result->event : "";
  out->json = result->json ? result->json : "";

  const int32_t token_count = result->count > 0 ? result->count : 0;
  out->tokens.reserve(token_count);
  out->token_text_storage.reserve(token_count);

  for (int32_t i = 0; i < token_count; ++i) {
    out->token_text_storage.emplace_back(
        result->tokens_arr ? result->tokens_arr[i] : "");

    wfloat_stt_token_t token{};
    token.start_sec = result->timestamps ? result->timestamps[i] : -1.0f;
    token.duration_sec = result->durations ? result->durations[i] : 0.0f;
    token.confidence =
        result->ys_log_probs ? static_cast<float>(exp(result->ys_log_probs[i]))
                             : 0.0f;
    out->tokens.push_back(token);
  }

  const int32_t segment_count =
      result->segment_count > 0 ? result->segment_count : 0;
  out->segments.reserve(segment_count);
  out->segment_text_storage.reserve(segment_count);

  for (int32_t i = 0; i < segment_count; ++i) {
    out->segment_text_storage.emplace_back(
        result->segment_texts_arr ? result->segment_texts_arr[i] : "");

    wfloat_stt_segment_t segment{};
    segment.start_sec =
        result->segment_timestamps ? result->segment_timestamps[i] : -1.0f;
    segment.duration_sec =
        result->segment_durations ? result->segment_durations[i] : 0.0f;
    out->segments.push_back(segment);
  }

  out->Finalize();
  return kStatusOk;
}

int32_t PopulateSessionResult(const wfloat_stt_model_t *model,
                              const SherpaOnnxOnlineRecognizerResult *result,
                              int32_t is_endpoint,
                              OwnedSessionResult *out) {
  if (!model || !result || !out) {
    return kStatusInvalidArgument;
  }

  out->model_id = model->config.model_id;
  out->text = result->text ? result->text : "";
  out->json = result->json ? result->json : "";
  out->is_endpoint = is_endpoint;
  out->Finalize();
  return kStatusOk;
}

void DestroyModelStorage(wfloat_stt_model_t *model) {
  if (!model) {
    return;
  }

  if (model->recognizer) {
    SherpaOnnxDestroyOfflineRecognizer(model->recognizer);
    model->recognizer = nullptr;
  }

  if (model->online_recognizer) {
    SherpaOnnxDestroyOnlineRecognizer(model->online_recognizer);
    model->online_recognizer = nullptr;
  }

  delete model;
}

void MaybeDestroyPendingModel(wfloat_stt_model_t *model) {
  if (!model) {
    return;
  }

  if (model->destroy_pending && model->active_session_count == 0) {
    DestroyModelStorage(model);
  }
}

int32_t DecodeOnlineSession(const wfloat_stt_session_t *session) {
  if (!session || !session->model || !session->stream ||
      !session->model->online_recognizer) {
    return kStatusInvalidArgument;
  }

  while (SherpaOnnxIsOnlineStreamReady(session->model->online_recognizer,
                                       session->stream)) {
    SherpaOnnxDecodeOnlineStream(session->model->online_recognizer,
                                 session->stream);
  }

  return kStatusOk;
}

int32_t BuildSessionResult(wfloat_stt_session_t *session,
                           wfloat_stt_session_result_t **out_result) {
  if (!session || !out_result || !session->model || !session->stream ||
      !session->model->online_recognizer) {
    return kStatusInvalidArgument;
  }

  *out_result = nullptr;

  const SherpaOnnxOnlineRecognizerResult *recognizer_result =
      SherpaOnnxGetOnlineStreamResult(session->model->online_recognizer,
                                     session->stream);
  if (!recognizer_result) {
    return kStatusBackendError;
  }

  const int32_t is_endpoint = SherpaOnnxOnlineStreamIsEndpoint(
      session->model->online_recognizer, session->stream);

  std::unique_ptr<OwnedSessionResult> owned(new OwnedSessionResult);
  int32_t populate_status = PopulateSessionResult(
      session->model, recognizer_result, is_endpoint, owned.get());

  SherpaOnnxDestroyOnlineRecognizerResult(recognizer_result);

  if (populate_status != kStatusOk) {
    return populate_status;
  }

  *out_result = &owned.release()->base;
  return kStatusOk;
}

}  // namespace

int32_t wfloat_stt_model_create(const wfloat_stt_model_config_t *config,
                                wfloat_stt_model_t **out_model) {
  if (!config || !out_model) {
    return kStatusInvalidArgument;
  }

  *out_model = nullptr;

  StoredSttConfig stored = CopyConfig(config);
  int32_t validation_status = ValidateConfig(stored);
  if (validation_status != kStatusOk) {
    return validation_status;
  }

  std::unique_ptr<wfloat_stt_model_t> model(new wfloat_stt_model_t);
  model->config = std::move(stored);
  model->family_name = FamilyName(model->config.family);
  model->feature_flags = FeatureFlagsForConfig(model->config);
  model->sample_rate = model->config.sample_rate;
  model->supports_language_override =
      model->config.family == WFLOAT_STT_FAMILY_WHISPER ? 1 : 0;

  if (model->config.family == WFLOAT_STT_FAMILY_ZIPFORMER_TRANSDUCER) {
    SherpaOnnxOnlineRecognizerConfig recognizer_config =
        BuildOnlineRecognizerConfig(model->config);
    model->online_recognizer =
        SherpaOnnxCreateOnlineRecognizer(&recognizer_config);
    if (!model->online_recognizer) {
      return kStatusBackendError;
    }
  } else {
    SherpaOnnxOfflineRecognizerConfig recognizer_config =
        BuildRecognizerConfig(model->config, nullptr, nullptr);
    model->recognizer = SherpaOnnxCreateOfflineRecognizer(&recognizer_config);
    if (!model->recognizer) {
      return kStatusBackendError;
    }
  }

  *out_model = model.release();
  return kStatusOk;
}

void wfloat_stt_model_destroy(wfloat_stt_model_t *model) {
  if (!model) {
    return;
  }

  if (model->active_session_count > 0) {
    model->destroy_pending = true;
    return;
  }

  DestroyModelStorage(model);
}

int32_t wfloat_stt_model_get_info(const wfloat_stt_model_t *model,
                                  wfloat_stt_model_info_t *out_info) {
  if (!model || !out_info) {
    return kStatusInvalidArgument;
  }

  memset(out_info, 0, sizeof(*out_info));
  out_info->model_id = model->config.model_id.c_str();
  out_info->backend = model->backend.c_str();
  out_info->family = model->family_name.c_str();
  out_info->feature_flags = model->feature_flags;
  out_info->sample_rate = model->sample_rate;
  out_info->supports_language_override = model->supports_language_override;
  return kStatusOk;
}

int32_t wfloat_stt_model_transcribe(
    const wfloat_stt_model_t *model,
    const wfloat_stt_transcribe_options_t *options,
    wfloat_stt_transcription_result_t **out_result) {
  if (!model || !options || !out_result || !model->recognizer ||
      !options->samples || options->sample_count == 0 || options->sample_rate <= 0) {
    if (model && !model->recognizer && model->online_recognizer) {
      return kStatusNotSupported;
    }
    return kStatusInvalidArgument;
  }

  *out_result = nullptr;

  auto *mutable_model = const_cast<wfloat_stt_model_t *>(model);
  int32_t set_status =
      SetRecognizerConfig(mutable_model, options->language, options->task);
  if (set_status != kStatusOk) {
    return set_status;
  }

  const SherpaOnnxOfflineStream *stream =
      IsNullOrEmpty(options->hotwords)
          ? SherpaOnnxCreateOfflineStream(model->recognizer)
          : SherpaOnnxCreateOfflineStreamWithHotwords(model->recognizer,
                                                      options->hotwords);
  if (!stream) {
    return kStatusBackendError;
  }

  SherpaOnnxAcceptWaveformOffline(
      stream, options->sample_rate, options->samples,
      static_cast<int32_t>(options->sample_count));
  SherpaOnnxDecodeOfflineStream(model->recognizer, stream);

  const SherpaOnnxOfflineRecognizerResult *recognizer_result =
      SherpaOnnxGetOfflineStreamResult(stream);
  if (!recognizer_result) {
    SherpaOnnxDestroyOfflineStream(stream);
    return kStatusBackendError;
  }

  std::unique_ptr<OwnedTranscriptionResult> owned(new OwnedTranscriptionResult);
  int32_t populate_status =
      PopulateResult(model, recognizer_result, owned.get());

  SherpaOnnxDestroyOfflineRecognizerResult(recognizer_result);
  SherpaOnnxDestroyOfflineStream(stream);

  if (populate_status != kStatusOk) {
    return populate_status;
  }

  *out_result = &owned.release()->base;
  return kStatusOk;
}

void wfloat_stt_transcription_result_destroy(
    wfloat_stt_transcription_result_t *result) {
  delete reinterpret_cast<OwnedTranscriptionResult *>(result);
}

int32_t wfloat_stt_model_create_session(const wfloat_stt_model_t *model,
                                        wfloat_stt_session_t **out_session) {
  if (!model || !out_session) {
    return kStatusInvalidArgument;
  }

  *out_session = nullptr;
  auto *mutable_model = const_cast<wfloat_stt_model_t *>(model);
  if (!mutable_model->online_recognizer) {
    return kStatusNotSupported;
  }

  const SherpaOnnxOnlineStream *stream =
      SherpaOnnxCreateOnlineStream(mutable_model->online_recognizer);
  if (!stream) {
    return kStatusBackendError;
  }

  std::unique_ptr<wfloat_stt_session_t> session(new wfloat_stt_session_t);
  session->model = mutable_model;
  session->stream = stream;
  mutable_model->active_session_count += 1;

  *out_session = session.release();
  return kStatusOk;
}

int32_t wfloat_stt_session_push_audio(wfloat_stt_session_t *session,
                                      const float *samples,
                                      size_t sample_count,
                                      int32_t sample_rate) {
  if (!session || !samples || sample_count == 0 || sample_rate <= 0) {
    return kStatusInvalidArgument;
  }

  if (!session->model || !session->stream || !session->model->online_recognizer) {
    return kStatusNotSupported;
  }

  if (sample_count > static_cast<size_t>(INT32_MAX)) {
    return kStatusInvalidArgument;
  }

  SherpaOnnxOnlineStreamAcceptWaveform(
      session->stream, sample_rate, samples,
      static_cast<int32_t>(sample_count));
  return DecodeOnlineSession(session);
}

int32_t wfloat_stt_session_get_result(wfloat_stt_session_t *session,
                                      wfloat_stt_session_result_t **out_result) {
  if (!session || !out_result) {
    return kStatusInvalidArgument;
  }

  int32_t decode_status = DecodeOnlineSession(session);
  if (decode_status != kStatusOk) {
    return decode_status;
  }

  return BuildSessionResult(session, out_result);
}

int32_t wfloat_stt_session_finish(wfloat_stt_session_t *session,
                                  wfloat_stt_session_result_t **out_result) {
  if (!session || !out_result) {
    return kStatusInvalidArgument;
  }

  if (!session->model || !session->stream || !session->model->online_recognizer) {
    return kStatusNotSupported;
  }

  SherpaOnnxOnlineStreamInputFinished(session->stream);
  int32_t decode_status = DecodeOnlineSession(session);
  if (decode_status != kStatusOk) {
    return decode_status;
  }

  return BuildSessionResult(session, out_result);
}

int32_t wfloat_stt_session_reset(wfloat_stt_session_t *session) {
  if (!session) {
    return kStatusInvalidArgument;
  }

  if (!session->model || !session->stream || !session->model->online_recognizer) {
    return kStatusNotSupported;
  }

  SherpaOnnxOnlineStreamReset(session->model->online_recognizer,
                              session->stream);
  return kStatusOk;
}

void wfloat_stt_session_destroy(wfloat_stt_session_t *session) {
  if (!session) {
    return;
  }

  wfloat_stt_model_t *model = session->model;

  if (session->stream) {
    SherpaOnnxDestroyOnlineStream(session->stream);
    session->stream = nullptr;
  }

  if (model && model->active_session_count > 0) {
    model->active_session_count -= 1;
  }

  delete session;
  MaybeDestroyPendingModel(model);
}

void wfloat_stt_session_result_destroy(wfloat_stt_session_result_t *result) {
  delete reinterpret_cast<OwnedSessionResult *>(result);
}
