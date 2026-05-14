#include "wfloat-core/wfloat_tts.h"

#include <stddef.h>
#include <stdint.h>

#include <exception>
#include <memory>
#include <string>
#include <unordered_map>
#include <utility>
#include <vector>

#include "sherpa-onnx/csrc/offline-tts.h"

struct wfloat_tts_model {
  std::string model_id;
  std::string backend;
  std::string family_name;
  uint64_t feature_flags = WFLOAT_TTS_FEATURE_NONE;
  wfloat_tts_family_t family = WFLOAT_TTS_FAMILY_UNKNOWN;
  std::unique_ptr<sherpa_onnx::OfflineTts> tts;
};

namespace {

constexpr float kDefaultSpeed = 1.0f;
constexpr float kDefaultSilenceScale = 0.2f;
constexpr float kDefaultNoiseScale = 0.667f;
constexpr float kDefaultNoiseScaleW = 0.8f;
constexpr float kDefaultLengthScale = 1.0f;
constexpr float kDefaultSilencePaddingSec = 0.1f;

struct OwnedSynthesisResult {
  wfloat_tts_synthesis_result_t base{};

  std::vector<float> samples;
  std::vector<wfloat_tts_timeline_chunk_t> chunks;
  std::vector<std::string> chunk_text_storage;
  std::vector<std::string> chunk_voice_storage;

  std::string model_id;
  std::string text;

  void Finalize() {
    base.audio.samples = samples.empty() ? nullptr : samples.data();
    base.audio.sample_count = samples.size();
    base.audio.duration_sec =
        base.audio.sample_rate > 0
            ? static_cast<float>(samples.size()) / base.audio.sample_rate
            : 0.0f;

    for (size_t i = 0; i < chunks.size(); ++i) {
      chunks[i].text = chunk_text_storage[i].c_str();
      if (chunk_voice_storage[i].empty()) {
        chunks[i].voice = nullptr;
      } else {
        chunks[i].voice = chunk_voice_storage[i].c_str();
      }
    }

    base.timeline.chunks = chunks.empty() ? nullptr : chunks.data();
    base.timeline.chunk_count = chunks.size();
    base.timeline.duration_sec = base.audio.duration_sec;
    base.model_id = model_id.c_str();
    base.text = text.c_str();
  }
};

struct SegmentPlan {
  std::string text;
  std::string voice;
  int32_t sid = 0;
  float speed = kDefaultSpeed;
  float silence_padding_sec = 0.0f;
  int32_t segment_index = -1;
  std::string emotion;
  float intensity = 0.0f;
  bool use_wfloat_prepare = false;
  sherpa_onnx::WfloatPreparedText prepared;
};

struct ProgressContext {
  wfloat_tts_progress_callback_t callback = nullptr;
  void *user_data = nullptr;
  bool cancelled = false;
  int32_t total_chunks = 0;
  int32_t emitted_chunks = 0;
};

std::string OrEmpty(const char *value) {
  return value ? std::string(value) : std::string();
}

bool IsNullOrEmpty(const char *value) { return value == nullptr || *value == '\0'; }

int32_t DefaultThreads(int32_t value) { return value > 0 ? value : 1; }

float DefaultPositive(float value, float default_value) {
  return value > 0 ? value : default_value;
}

float DefaultNonNegative(float value, float default_value) {
  return value >= 0 ? value : default_value;
}

const char *FamilyName(wfloat_tts_family_t family) {
  switch (family) {
    case WFLOAT_TTS_FAMILY_WFLOAT_EXPRESSIVE:
      return "wfloat-expressive-tts";
    case WFLOAT_TTS_FAMILY_PIPER:
      return "piper";
    case WFLOAT_TTS_FAMILY_MATCHA:
      return "matcha";
    case WFLOAT_TTS_FAMILY_KOKORO:
      return "kokoro";
    case WFLOAT_TTS_FAMILY_ZIPVOICE:
      return "zipvoice";
    case WFLOAT_TTS_FAMILY_KITTEN:
      return "kitten";
    case WFLOAT_TTS_FAMILY_POCKET:
      return "pocket";
    case WFLOAT_TTS_FAMILY_UNKNOWN:
    default:
      return "unknown";
  }
}

uint64_t FeatureFlagsForFamily(wfloat_tts_family_t family) {
  uint64_t flags = WFLOAT_TTS_FEATURE_TIMELINE;

  switch (family) {
    case WFLOAT_TTS_FAMILY_WFLOAT_EXPRESSIVE:
      flags |= WFLOAT_TTS_FEATURE_DIALOGUE;
      flags |= WFLOAT_TTS_FEATURE_EMOTION;
      flags |= WFLOAT_TTS_FEATURE_SPEAKER_SELECTION;
      flags |= WFLOAT_TTS_FEATURE_PHONEME_CONVERSION;
      break;
    case WFLOAT_TTS_FAMILY_PIPER:
      flags |= WFLOAT_TTS_FEATURE_SPEAKER_SELECTION;
      break;
    case WFLOAT_TTS_FAMILY_KOKORO:
    case WFLOAT_TTS_FAMILY_KITTEN:
      flags |= WFLOAT_TTS_FEATURE_SPEAKER_SELECTION;
      break;
    case WFLOAT_TTS_FAMILY_MATCHA:
    case WFLOAT_TTS_FAMILY_POCKET:
    case WFLOAT_TTS_FAMILY_ZIPVOICE:
    case WFLOAT_TTS_FAMILY_UNKNOWN:
    default:
      break;
  }

  return flags;
}

bool LookupExtraString(const wfloat_string_map_entry_t *entries,
                       size_t count, const char *key, std::string *out) {
  if (!entries || !key || !out) {
    return false;
  }

  for (size_t i = 0; i < count; ++i) {
    if (!entries[i].key || !entries[i].value) {
      continue;
    }
    if (std::string(entries[i].key) == key) {
      *out = entries[i].value;
      return true;
    }
  }

  return false;
}

bool LookupExtraFloat(const wfloat_string_map_entry_t *entries,
                      size_t count, const char *key, float *out) {
  if (!entries || !key || !out) {
    return false;
  }

  std::string value;
  if (!LookupExtraString(entries, count, key, &value)) {
    return false;
  }

  try {
    *out = std::stof(value);
    return true;
  } catch (const std::exception &) {
    return false;
  }
}

std::unordered_map<std::string, std::string> BuildExtraMap(
    const wfloat_string_map_entry_t *entries, size_t count) {
  std::unordered_map<std::string, std::string> extra;
  if (!entries) {
    return extra;
  }

  for (size_t i = 0; i < count; ++i) {
    if (!entries[i].key || !entries[i].value) {
      continue;
    }
    extra[entries[i].key] = entries[i].value;
  }

  return extra;
}

int32_t EmitProgress(ProgressContext *context,
                     wfloat_tts_progress_stage_t stage, float progress,
                     int32_t chunk_index, int32_t chunk_count,
                     const char *text, int32_t highlight_start,
                     int32_t highlight_end) {
  if (!context || !context->callback) {
    return 1;
  }

  wfloat_tts_progress_event_t event{};
  event.stage = stage;
  event.progress = progress;
  event.chunk_index = chunk_index;
  event.chunk_count = chunk_count;
  event.text = text;
  event.highlight_start = highlight_start;
  event.highlight_end = highlight_end;

  int32_t rc = context->callback(&event, context->user_data);
  if (rc == 0) {
    context->cancelled = true;
  }
  return rc;
}

wfloat_status_t BuildSherpaConfig(const wfloat_tts_model_config_t *config,
                                  sherpa_onnx::OfflineTtsConfig *out) {
  if (!config || !out) {
    return WFLOAT_STATUS_INVALID_ARGUMENT;
  }

  sherpa_onnx::OfflineTtsModelConfig model_config;
  model_config.num_threads = DefaultThreads(config->num_threads);
  model_config.debug = config->debug != 0;
  model_config.provider = IsNullOrEmpty(config->provider) ? "cpu" : config->provider;

  switch (config->family) {
    case WFLOAT_TTS_FAMILY_WFLOAT_EXPRESSIVE: {
      sherpa_onnx::OfflineTtsWfloatModelConfig wfloat;
      wfloat.model = OrEmpty(config->model_path);
      wfloat.lexicon = OrEmpty(config->lexicon_path);
      wfloat.tokens = OrEmpty(config->tokens_path);
      wfloat.data_dir = OrEmpty(config->data_dir);
      wfloat.noise_scale = DefaultPositive(config->noise_scale, kDefaultNoiseScale);
      wfloat.noise_scale_w =
          DefaultPositive(config->noise_scale_w, kDefaultNoiseScaleW);
      wfloat.length_scale =
          DefaultPositive(config->length_scale, kDefaultLengthScale);
      model_config.wfloat = std::move(wfloat);
      break;
    }
    case WFLOAT_TTS_FAMILY_PIPER: {
      sherpa_onnx::OfflineTtsVitsModelConfig vits;
      vits.model = OrEmpty(config->model_path);
      vits.lexicon = OrEmpty(config->lexicon_path);
      vits.tokens = OrEmpty(config->tokens_path);
      vits.data_dir = OrEmpty(config->data_dir);
      vits.noise_scale = DefaultPositive(config->noise_scale, kDefaultNoiseScale);
      vits.noise_scale_w =
          DefaultPositive(config->noise_scale_w, kDefaultNoiseScaleW);
      vits.length_scale =
          DefaultPositive(config->length_scale, kDefaultLengthScale);
      model_config.vits = std::move(vits);
      break;
    }
    case WFLOAT_TTS_FAMILY_MATCHA: {
      sherpa_onnx::OfflineTtsMatchaModelConfig matcha;
      matcha.acoustic_model = OrEmpty(config->acoustic_model_path);
      matcha.vocoder = OrEmpty(config->vocoder_path);
      matcha.lexicon = OrEmpty(config->lexicon_path);
      matcha.tokens = OrEmpty(config->tokens_path);
      matcha.data_dir = OrEmpty(config->data_dir);
      matcha.noise_scale = DefaultPositive(config->noise_scale, kDefaultNoiseScale);
      matcha.length_scale =
          DefaultPositive(config->length_scale, kDefaultLengthScale);
      model_config.matcha = std::move(matcha);
      break;
    }
    case WFLOAT_TTS_FAMILY_KOKORO: {
      sherpa_onnx::OfflineTtsKokoroModelConfig kokoro;
      kokoro.model = OrEmpty(config->model_path);
      kokoro.voices = OrEmpty(config->voices_path);
      kokoro.tokens = OrEmpty(config->tokens_path);
      kokoro.data_dir = OrEmpty(config->data_dir);
      kokoro.lexicon = OrEmpty(config->lexicon_path);
      kokoro.lang = OrEmpty(config->lang);
      kokoro.length_scale =
          DefaultPositive(config->length_scale, kDefaultLengthScale);
      model_config.kokoro = std::move(kokoro);
      break;
    }
    case WFLOAT_TTS_FAMILY_ZIPVOICE: {
      sherpa_onnx::OfflineTtsZipvoiceModelConfig zipvoice;
      zipvoice.tokens = OrEmpty(config->tokens_path);
      zipvoice.encoder = OrEmpty(config->encoder_path);
      zipvoice.decoder = OrEmpty(config->decoder_path);
      zipvoice.vocoder = OrEmpty(config->vocoder_path);
      zipvoice.data_dir = OrEmpty(config->data_dir);
      zipvoice.lexicon = OrEmpty(config->lexicon_path);
      zipvoice.feat_scale = DefaultPositive(config->feat_scale, 0.1f);
      zipvoice.t_shift = DefaultPositive(config->t_shift, 0.5f);
      zipvoice.target_rms = DefaultPositive(config->target_rms, 0.1f);
      zipvoice.guidance_scale =
          DefaultPositive(config->guidance_scale, 1.0f);
      model_config.zipvoice = std::move(zipvoice);
      break;
    }
    case WFLOAT_TTS_FAMILY_KITTEN: {
      sherpa_onnx::OfflineTtsKittenModelConfig kitten;
      kitten.model = OrEmpty(config->model_path);
      kitten.voices = OrEmpty(config->voices_path);
      kitten.tokens = OrEmpty(config->tokens_path);
      kitten.data_dir = OrEmpty(config->data_dir);
      kitten.length_scale =
          DefaultPositive(config->length_scale, kDefaultLengthScale);
      model_config.kitten = std::move(kitten);
      break;
    }
    case WFLOAT_TTS_FAMILY_POCKET: {
      sherpa_onnx::OfflineTtsPocketModelConfig pocket;
      pocket.lm_flow = OrEmpty(config->lm_flow_path);
      pocket.lm_main = OrEmpty(config->lm_main_path);
      pocket.encoder = OrEmpty(config->encoder_path);
      pocket.decoder = OrEmpty(config->decoder_path);
      pocket.text_conditioner = OrEmpty(config->text_conditioner_path);
      pocket.vocab_json = OrEmpty(config->vocab_json_path);
      pocket.token_scores_json = OrEmpty(config->token_scores_json_path);
      model_config.pocket = std::move(pocket);
      break;
    }
    case WFLOAT_TTS_FAMILY_UNKNOWN:
    default:
      return WFLOAT_STATUS_NOT_SUPPORTED;
  }

  out->model = std::move(model_config);
  out->rule_fsts = OrEmpty(config->rule_fsts);
  out->rule_fars = OrEmpty(config->rule_fars);
  out->max_num_sentences = config->max_num_sentences > 0 ? config->max_num_sentences : 1;
  out->silence_scale =
      DefaultNonNegative(config->silence_scale, kDefaultSilenceScale);

  if (!out->Validate()) {
    return WFLOAT_STATUS_INVALID_ARGUMENT;
  }

  return WFLOAT_STATUS_OK;
}

void AppendSilence(OwnedSynthesisResult *result, int32_t sample_rate,
                   float silence_sec) {
  if (!result || sample_rate <= 0 || silence_sec <= 0.0f) {
    return;
  }

  size_t silence_samples =
      static_cast<size_t>(silence_sec * static_cast<float>(sample_rate));
  result->samples.insert(result->samples.end(), silence_samples, 0.0f);
}

wfloat_status_t AppendGeneratedChunk(
    OwnedSynthesisResult *result, const sherpa_onnx::GeneratedAudio &audio,
    const std::string &text, const std::string &voice, int32_t sid,
    int32_t segment_index, int32_t highlight_start, int32_t highlight_end,
    float progress) {
  if (!result) {
    return WFLOAT_STATUS_INVALID_ARGUMENT;
  }

  if (audio.sample_rate <= 0) {
    return WFLOAT_STATUS_BACKEND_ERROR;
  }

  if (result->base.audio.sample_rate == 0) {
    result->base.audio.sample_rate = audio.sample_rate;
  } else if (result->base.audio.sample_rate != audio.sample_rate) {
    return WFLOAT_STATUS_BACKEND_ERROR;
  }

  float start_sec = result->base.audio.sample_rate > 0
                        ? static_cast<float>(result->samples.size()) /
                              result->base.audio.sample_rate
                        : 0.0f;

  result->samples.insert(result->samples.end(), audio.samples.begin(),
                         audio.samples.end());

  float end_sec = result->base.audio.sample_rate > 0
                      ? static_cast<float>(result->samples.size()) /
                            result->base.audio.sample_rate
                      : start_sec;

  result->chunk_text_storage.push_back(text);
  result->chunk_voice_storage.push_back(voice);

  wfloat_tts_timeline_chunk_t chunk{};
  chunk.index = static_cast<int32_t>(result->chunks.size());
  chunk.highlight_start = highlight_start;
  chunk.highlight_end = highlight_end;
  chunk.start_sec = start_sec;
  chunk.end_sec = end_sec;
  chunk.duration_sec = end_sec - start_sec;
  chunk.progress = progress;
  chunk.sid = sid;
  chunk.segment_index = segment_index;
  result->chunks.push_back(chunk);
  return WFLOAT_STATUS_OK;
}

sherpa_onnx::GenerationConfig BuildGenerationConfig(
    const wfloat_tts_synthesize_options_t *options) {
  sherpa_onnx::GenerationConfig cfg;
  cfg.speed = options ? DefaultPositive(options->speed, kDefaultSpeed) : kDefaultSpeed;
  cfg.sid = options ? options->sid : 0;
  cfg.num_steps = options && options->num_steps > 0 ? options->num_steps : 5;

  if (options && options->reference_audio &&
      options->reference_audio_sample_count > 0) {
    cfg.reference_audio.assign(
        options->reference_audio,
        options->reference_audio + options->reference_audio_sample_count);
    cfg.reference_sample_rate = options->reference_audio_sample_rate;
  }

  if (options) {
    cfg.reference_text = OrEmpty(options->reference_text);
    cfg.extra = BuildExtraMap(options->extra_entries, options->extra_entry_count);
  }

  return cfg;
}

wfloat_status_t SynthesizeGeneric(
    const wfloat_tts_model_t *model, const wfloat_tts_synthesize_options_t *options,
    ProgressContext *progress, OwnedSynthesisResult *result) {
  if (!model || !options || !result) {
    return WFLOAT_STATUS_INVALID_ARGUMENT;
  }

  std::string text = OrEmpty(options->text);
  if (text.empty()) {
    return WFLOAT_STATUS_INVALID_ARGUMENT;
  }

  EmitProgress(progress, WFLOAT_TTS_PROGRESS_STAGE_PREPARING, 0.0f, 0, 1,
               text.c_str(), 0, static_cast<int32_t>(text.size()));

  sherpa_onnx::GenerationConfig cfg = BuildGenerationConfig(options);
  bool callback_cancelled = false;
  auto callback = [progress, &text, &callback_cancelled](
                      const float *, int32_t, float callback_progress) -> int32_t {
    if (!progress || !progress->callback) {
      return 1;
    }
    int32_t rc = EmitProgress(progress, WFLOAT_TTS_PROGRESS_STAGE_GENERATING,
                              callback_progress, 0, 1, text.c_str(), 0,
                              static_cast<int32_t>(text.size()));
    if (rc == 0) {
      callback_cancelled = true;
    }
    return rc;
  };

  sherpa_onnx::GeneratedAudio audio = progress && progress->callback
                                          ? model->tts->Generate(text, cfg, callback)
                                          : model->tts->Generate(text, cfg);

  if (callback_cancelled || (progress && progress->cancelled)) {
    return WFLOAT_STATUS_CANCELLED;
  }

  result->text = text;
  wfloat_status_t status = AppendGeneratedChunk(
      result, audio, text, OrEmpty(options->voice), options->sid, -1, 0,
      static_cast<int32_t>(text.size()), 1.0f);
  if (status != WFLOAT_STATUS_OK) {
    return status;
  }

  EmitProgress(progress, WFLOAT_TTS_PROGRESS_STAGE_COMPLETED, 1.0f, 0, 1,
               text.c_str(), 0, static_cast<int32_t>(text.size()));
  return WFLOAT_STATUS_OK;
}

wfloat_status_t SynthesizeWfloat(
    const wfloat_tts_model_t *model, const wfloat_tts_synthesize_options_t *options,
    ProgressContext *progress, OwnedSynthesisResult *result) {
  if (!model || !options || !result) {
    return WFLOAT_STATUS_INVALID_ARGUMENT;
  }

  std::string text = OrEmpty(options->text);
  if (text.empty()) {
    return WFLOAT_STATUS_INVALID_ARGUMENT;
  }

  std::string emotion;
  float intensity = 0.0f;
  LookupExtraString(options->extra_entries, options->extra_entry_count, "emotion",
                    &emotion);
  LookupExtraFloat(options->extra_entries, options->extra_entry_count, "intensity",
                   &intensity);

  EmitProgress(progress, WFLOAT_TTS_PROGRESS_STAGE_PREPARING, 0.0f, 0, 0,
               text.c_str(), 0, static_cast<int32_t>(text.size()));

  sherpa_onnx::WfloatPreparedText prepared =
      model->tts->PrepareWfloatText(text, emotion, intensity);
  if (prepared.text_clean.empty()) {
    return WFLOAT_STATUS_BACKEND_ERROR;
  }

  result->text = text;
  float silence_padding_sec =
      DefaultNonNegative(options->silence_padding_sec, kDefaultSilencePaddingSec);
  int32_t raw_cursor = 0;

  for (size_t i = 0; i < prepared.text_clean.size(); ++i) {
    const std::string &raw_chunk_text = prepared.text[i];
    int32_t highlight_start = raw_cursor;
    int32_t highlight_end =
        raw_cursor + static_cast<int32_t>(raw_chunk_text.size());
    raw_cursor = highlight_end;

    sherpa_onnx::GeneratedAudio audio = model->tts->Generate(
        prepared.text_clean[i], options->sid,
        DefaultPositive(options->speed, kDefaultSpeed));

    float chunk_progress = static_cast<float>(i + 1) /
                           static_cast<float>(prepared.text_clean.size());
    wfloat_status_t status = AppendGeneratedChunk(
        result, audio, raw_chunk_text, OrEmpty(options->voice), options->sid, -1,
        highlight_start, highlight_end, chunk_progress);
    if (status != WFLOAT_STATUS_OK) {
      return status;
    }

    if (i + 1 < prepared.text_clean.size()) {
      AppendSilence(result, result->base.audio.sample_rate, silence_padding_sec);
    }

    int32_t rc = EmitProgress(progress, WFLOAT_TTS_PROGRESS_STAGE_GENERATING,
                              chunk_progress, static_cast<int32_t>(i),
                              static_cast<int32_t>(prepared.text_clean.size()),
                              raw_chunk_text.c_str(), highlight_start,
                              highlight_end);
    if (rc == 0) {
      return WFLOAT_STATUS_CANCELLED;
    }
  }

  EmitProgress(progress, WFLOAT_TTS_PROGRESS_STAGE_COMPLETED, 1.0f,
               static_cast<int32_t>(prepared.text_clean.size() - 1),
               static_cast<int32_t>(prepared.text_clean.size()), text.c_str(), 0,
               static_cast<int32_t>(text.size()));
  return WFLOAT_STATUS_OK;
}

wfloat_status_t BuildDialoguePlan(const wfloat_tts_model_t *model,
                                  const wfloat_tts_dialogue_options_t *options,
                                  std::vector<SegmentPlan> *out_plans) {
  if (!model || !options || !out_plans || !options->segments ||
      options->segment_count == 0) {
    return WFLOAT_STATUS_INVALID_ARGUMENT;
  }

  out_plans->clear();
  out_plans->reserve(options->segment_count);

  for (size_t i = 0; i < options->segment_count; ++i) {
    const auto &segment = options->segments[i];
    SegmentPlan plan;
    plan.text = OrEmpty(segment.text);
    plan.voice = OrEmpty(segment.voice);
    plan.sid = segment.sid;
    plan.speed = DefaultPositive(segment.speed, kDefaultSpeed);
    plan.silence_padding_sec =
        DefaultNonNegative(segment.silence_padding_sec, kDefaultSilencePaddingSec);
    plan.segment_index = static_cast<int32_t>(i);
    plan.use_wfloat_prepare =
        model->family == WFLOAT_TTS_FAMILY_WFLOAT_EXPRESSIVE;

    if (plan.text.empty()) {
      return WFLOAT_STATUS_INVALID_ARGUMENT;
    }

    if (plan.use_wfloat_prepare) {
      LookupExtraString(segment.extra_entries, segment.extra_entry_count, "emotion",
                        &plan.emotion);
      LookupExtraFloat(segment.extra_entries, segment.extra_entry_count,
                       "intensity", &plan.intensity);
      plan.prepared =
          model->tts->PrepareWfloatText(plan.text, plan.emotion, plan.intensity);
      if (plan.prepared.text_clean.empty()) {
        return WFLOAT_STATUS_BACKEND_ERROR;
      }
    }

    out_plans->push_back(std::move(plan));
  }

  return WFLOAT_STATUS_OK;
}

int32_t CountDialogueChunks(const std::vector<SegmentPlan> &plans) {
  int32_t total = 0;
  for (const auto &plan : plans) {
    total += plan.use_wfloat_prepare
                 ? static_cast<int32_t>(plan.prepared.text_clean.size())
                 : 1;
  }
  return total;
}

wfloat_status_t SynthesizeDialogue(
    const wfloat_tts_model_t *model, const wfloat_tts_dialogue_options_t *options,
    ProgressContext *progress, OwnedSynthesisResult *result) {
  std::vector<SegmentPlan> plans;
  wfloat_status_t status = BuildDialoguePlan(model, options, &plans);
  if (status != WFLOAT_STATUS_OK) {
    return status;
  }

  progress->total_chunks = CountDialogueChunks(plans);
  EmitProgress(progress, WFLOAT_TTS_PROGRESS_STAGE_PREPARING, 0.0f, 0,
               progress->total_chunks, nullptr, 0, 0);

  std::string full_text;
  for (size_t i = 0; i < plans.size(); ++i) {
    if (i > 0) {
      full_text.append(" ");
    }
    full_text.append(plans[i].text);
  }
  result->text = full_text;

  int32_t global_offset = 0;
  for (size_t segment_index = 0; segment_index < plans.size(); ++segment_index) {
    const auto &plan = plans[segment_index];

    if (plan.use_wfloat_prepare) {
      int32_t local_cursor = 0;
      for (size_t chunk_index = 0; chunk_index < plan.prepared.text_clean.size();
           ++chunk_index) {
        const std::string &raw_chunk_text = plan.prepared.text[chunk_index];
        int32_t highlight_start = global_offset + local_cursor;
        int32_t highlight_end =
            highlight_start + static_cast<int32_t>(raw_chunk_text.size());
        local_cursor += static_cast<int32_t>(raw_chunk_text.size());

        sherpa_onnx::GeneratedAudio audio = model->tts->Generate(
            plan.prepared.text_clean[chunk_index], plan.sid, plan.speed);

        progress->emitted_chunks += 1;
        float chunk_progress =
            static_cast<float>(progress->emitted_chunks) / progress->total_chunks;

        status = AppendGeneratedChunk(result, audio, raw_chunk_text, plan.voice,
                                      plan.sid, plan.segment_index,
                                      highlight_start, highlight_end,
                                      chunk_progress);
        if (status != WFLOAT_STATUS_OK) {
          return status;
        }

        float silence_sec = 0.0f;
        if (chunk_index + 1 < plan.prepared.text_clean.size()) {
          silence_sec = plan.silence_padding_sec;
        } else if (segment_index + 1 < plans.size()) {
          silence_sec = DefaultNonNegative(options->silence_between_segments_sec, 0.2f);
        }
        AppendSilence(result, result->base.audio.sample_rate, silence_sec);

        int32_t rc = EmitProgress(progress,
                                  WFLOAT_TTS_PROGRESS_STAGE_GENERATING,
                                  chunk_progress, progress->emitted_chunks - 1,
                                  progress->total_chunks, raw_chunk_text.c_str(),
                                  highlight_start, highlight_end);
        if (rc == 0) {
          return WFLOAT_STATUS_CANCELLED;
        }
      }
    } else {
      sherpa_onnx::GenerationConfig cfg;
      cfg.sid = plan.sid;
      cfg.speed = plan.speed;

      sherpa_onnx::GeneratedAudio audio = model->tts->Generate(plan.text, cfg);
      progress->emitted_chunks += 1;
      float chunk_progress =
          static_cast<float>(progress->emitted_chunks) / progress->total_chunks;

      status = AppendGeneratedChunk(
          result, audio, plan.text, plan.voice, plan.sid, plan.segment_index,
          global_offset, global_offset + static_cast<int32_t>(plan.text.size()),
          chunk_progress);
      if (status != WFLOAT_STATUS_OK) {
        return status;
      }

      if (segment_index + 1 < plans.size()) {
        AppendSilence(result, result->base.audio.sample_rate,
                      DefaultNonNegative(options->silence_between_segments_sec,
                                         0.2f));
      }

      int32_t rc = EmitProgress(
          progress, WFLOAT_TTS_PROGRESS_STAGE_GENERATING, chunk_progress,
          progress->emitted_chunks - 1, progress->total_chunks, plan.text.c_str(),
          global_offset,
          global_offset + static_cast<int32_t>(plan.text.size()));
      if (rc == 0) {
        return WFLOAT_STATUS_CANCELLED;
      }
    }

    global_offset += static_cast<int32_t>(plan.text.size());
    if (segment_index + 1 < plans.size()) {
      global_offset += 1;
    }
  }

  EmitProgress(progress, WFLOAT_TTS_PROGRESS_STAGE_COMPLETED, 1.0f,
               progress->total_chunks > 0 ? progress->total_chunks - 1 : 0,
               progress->total_chunks, full_text.c_str(), 0,
               static_cast<int32_t>(full_text.size()));
  return WFLOAT_STATUS_OK;
}

}  // namespace

extern "C" {

wfloat_status_t wfloat_tts_model_create(
    const wfloat_tts_model_config_t *config, wfloat_tts_model_t **out_model) {
  if (!config || !out_model) {
    return WFLOAT_STATUS_INVALID_ARGUMENT;
  }

  try {
    sherpa_onnx::OfflineTtsConfig sherpa_config;
    wfloat_status_t status = BuildSherpaConfig(config, &sherpa_config);
    if (status != WFLOAT_STATUS_OK) {
      return status;
    }

    auto model = std::make_unique<wfloat_tts_model>();
    model->model_id = IsNullOrEmpty(config->model_id) ? "unknown" : config->model_id;
    model->backend = "sherpa-onnx";
    model->family = config->family;
    model->family_name = FamilyName(config->family);
    model->feature_flags = FeatureFlagsForFamily(config->family);
    model->tts = std::make_unique<sherpa_onnx::OfflineTts>(sherpa_config);

    *out_model = model.release();
    return WFLOAT_STATUS_OK;
  } catch (const std::exception &) {
    return WFLOAT_STATUS_BACKEND_ERROR;
  } catch (...) {
    return WFLOAT_STATUS_INTERNAL_ERROR;
  }
}

void wfloat_tts_model_destroy(wfloat_tts_model_t *model) { delete model; }

wfloat_status_t wfloat_tts_model_get_info(const wfloat_tts_model_t *model,
                                          wfloat_tts_model_info_t *out_info) {
  if (!model || !out_info || !model->tts) {
    return WFLOAT_STATUS_INVALID_ARGUMENT;
  }

  out_info->model_id = model->model_id.c_str();
  out_info->backend = model->backend.c_str();
  out_info->family = model->family_name.c_str();
  out_info->feature_flags = model->feature_flags;
  out_info->sample_rate = model->tts->SampleRate();
  out_info->num_speakers = model->tts->NumSpeakers();
  return WFLOAT_STATUS_OK;
}

wfloat_status_t wfloat_tts_model_synthesize(
    const wfloat_tts_model_t *model,
    const wfloat_tts_synthesize_options_t *options,
    wfloat_tts_progress_callback_t progress_callback, void *user_data,
    wfloat_tts_synthesis_result_t **out_result) {
  if (!model || !options || !out_result || !model->tts) {
    return WFLOAT_STATUS_INVALID_ARGUMENT;
  }

  try {
    auto result = std::make_unique<OwnedSynthesisResult>();
    result->model_id = model->model_id;

    ProgressContext progress;
    progress.callback = progress_callback;
    progress.user_data = user_data;

    wfloat_status_t status =
        model->family == WFLOAT_TTS_FAMILY_WFLOAT_EXPRESSIVE
            ? SynthesizeWfloat(model, options, &progress, result.get())
            : SynthesizeGeneric(model, options, &progress, result.get());
    if (status != WFLOAT_STATUS_OK) {
      return status;
    }

    result->Finalize();
    *out_result = &result.release()->base;
    return WFLOAT_STATUS_OK;
  } catch (const std::exception &) {
    return WFLOAT_STATUS_BACKEND_ERROR;
  } catch (...) {
    return WFLOAT_STATUS_INTERNAL_ERROR;
  }
}

wfloat_status_t wfloat_tts_model_synthesize_dialogue(
    const wfloat_tts_model_t *model,
    const wfloat_tts_dialogue_options_t *options,
    wfloat_tts_progress_callback_t progress_callback, void *user_data,
    wfloat_tts_synthesis_result_t **out_result) {
  if (!model || !options || !out_result || !model->tts) {
    return WFLOAT_STATUS_INVALID_ARGUMENT;
  }

  try {
    auto result = std::make_unique<OwnedSynthesisResult>();
    result->model_id = model->model_id;

    ProgressContext progress;
    progress.callback = progress_callback;
    progress.user_data = user_data;

    wfloat_status_t status =
        SynthesizeDialogue(model, options, &progress, result.get());
    if (status != WFLOAT_STATUS_OK) {
      return status;
    }

    result->Finalize();
    *out_result = &result.release()->base;
    return WFLOAT_STATUS_OK;
  } catch (const std::exception &) {
    return WFLOAT_STATUS_BACKEND_ERROR;
  } catch (...) {
    return WFLOAT_STATUS_INTERNAL_ERROR;
  }
}

void wfloat_tts_synthesis_result_destroy(wfloat_tts_synthesis_result_t *result) {
  if (!result) {
    return;
  }

  auto *owned = reinterpret_cast<OwnedSynthesisResult *>(result);
  delete owned;
}

}  // extern "C"
