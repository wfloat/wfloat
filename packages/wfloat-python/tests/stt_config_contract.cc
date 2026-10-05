#include <cassert>
#include "wfloat_stt.cc"
// Recording C API backend: execute the real core lifecycle/transcription path
// without loading weights. Option changes must never recreate the recognizer.
struct SherpaOnnxOfflineRecognizer {};
struct SherpaOnnxOfflineStream {};
static SherpaOnnxOfflineRecognizer recognizer;
static SherpaOnnxOfflineStream stream;
static int creates = 0, destroys = 0, stream_creates = 0, stream_destroys = 0;
static int decodes = 0;
static bool silent = false;
struct SeenConfig {
  std::string language, task;
  int token_timestamps, segment_timestamps;
};
static std::vector<SeenConfig> seen;

extern "C" {
const SherpaOnnxOfflineRecognizer *SherpaOnnxCreateOfflineRecognizer(
    const SherpaOnnxOfflineRecognizerConfig *) {
  ++creates;
  return &recognizer;
}
void SherpaOnnxDestroyOfflineRecognizer(const SherpaOnnxOfflineRecognizer *r) {
  assert(r == &recognizer);
  ++destroys;
}
const SherpaOnnxOnlineRecognizer *SherpaOnnxCreateOnlineRecognizer(
    const SherpaOnnxOnlineRecognizerConfig *) {
  assert(false && "Whisper must remain offline");
  return nullptr;
}
void SherpaOnnxDestroyOnlineRecognizer(const SherpaOnnxOnlineRecognizer *) {
  assert(false && "Whisper must remain offline");
}
void SherpaOnnxOfflineRecognizerSetConfig(
    const SherpaOnnxOfflineRecognizer *r,
    const SherpaOnnxOfflineRecognizerConfig *config) {
  assert(r == &recognizer);
  const auto &w = config->model_config.whisper;
  seen.push_back({w.language, w.task, w.enable_token_timestamps,
                  w.enable_segment_timestamps});
}
const SherpaOnnxOfflineStream *SherpaOnnxCreateOfflineStream(
    const SherpaOnnxOfflineRecognizer *r) {
  assert(r == &recognizer);
  ++stream_creates;
  return &stream;
}
const SherpaOnnxOfflineStream *SherpaOnnxCreateOfflineStreamWithHotwords(
    const SherpaOnnxOfflineRecognizer *, const char *) {
  assert(false && "no hotwords in this regression");
  return nullptr;
}
void SherpaOnnxAcceptWaveformOffline(const SherpaOnnxOfflineStream *s,
                                    int32_t rate, const float *samples, int32_t n) {
  assert(s == &stream && rate == 16000 && n > 0);
  silent = true;
  for (int32_t i = 0; i < n; ++i) silent = silent && samples[i] == 0;
}
void SherpaOnnxDecodeOfflineStream(const SherpaOnnxOfflineRecognizer *r,
                                 const SherpaOnnxOfflineStream *s) {
  assert(r == &recognizer && s == &stream);
  ++decodes;
}
const SherpaOnnxOfflineRecognizerResult *SherpaOnnxGetOfflineStreamResult(
    const SherpaOnnxOfflineStream *s) {
  assert(s == &stream);
  static SherpaOnnxOfflineRecognizerResult result{};
  result.text = silent ? "" : "first successful transcription";
  return &result;
}
void SherpaOnnxDestroyOfflineRecognizerResult(const SherpaOnnxOfflineRecognizerResult *) {}
void SherpaOnnxDestroyOfflineStream(const SherpaOnnxOfflineStream *s) {
  assert(s == &stream);
  ++stream_destroys;
}
}

void CheckWhisperReuse() {
  // Timestamp capability is fixed at creation in the Python public SDK.
  for (int timestamps : {0, 1}) {
    wfloat_stt_model_config_t config{};
    config.model_id = "openai/whisper-small";
    config.family = WFLOAT_STT_FAMILY_WHISPER;
    config.encoder_path = "small-encoder.int8.onnx";
    config.decoder_path = "small-decoder.int8.onnx";
    config.tokens_path = "small-tokens.txt";
    config.language = "";
    config.task = "transcribe";
    config.enable_segment_timestamps = timestamps;
    wfloat_stt_model_t *model = nullptr;
    const int before = creates, destroyed_before = destroys;
    assert(wfloat_stt_model_create(&config, &model) == 0);
    assert(creates == before + 1);
    const char *languages[] = {"en", nullptr, "fr", nullptr, "en", ""};
    const char *tasks[] = {"transcribe", nullptr, "translate", nullptr, "translate", "transcribe"};
    for (int i = 0; i < 6; ++i) {
      // Regression trigger: successful explicit English call, then default auto
      // on silence. Keep the silence input; don't hide the transition.
      float samples[] = {i == 0 ? .1f : 0.f, 0.f};
      wfloat_stt_transcribe_options_t options{};
      options.samples = samples;
      options.sample_count = 2;
      options.sample_rate = 16000;
      options.language = languages[i];
      options.task = tasks[i];
      wfloat_stt_transcription_result_t *result = nullptr;
      assert(wfloat_stt_model_transcribe(model, &options, &result) == 0);
      assert(result && std::string(result->text) == (i == 0 ? "first successful transcription" : ""));
      assert(seen.back().language == (languages[i] ? languages[i] : ""));
      assert(seen.back().task == (tasks[i] ? tasks[i] : "transcribe"));
      assert(seen.back().segment_timestamps == timestamps);
      assert(seen.back().token_timestamps == 0);
      assert(creates == before + 1 && destroys == destroyed_before);
      assert(model->recognizer == &recognizer);
      assert(model->config.language.empty() && model->config.task == "transcribe");
      wfloat_stt_transcription_result_destroy(result);
    }
    wfloat_stt_model_destroy(model);
    assert(destroys == destroyed_before + 1);
  }
  assert(decodes == 12 && stream_creates == 12 && stream_destroys == 12);
}

int main() {
  CheckWhisperReuse();
  StoredSttConfig c;
  c.model_id = "moonshine-ai/moonshine-base";
  c.family = WFLOAT_STT_FAMILY_MOONSHINE;
  c.tokens_path = "tokens.txt";
  c.encoder_path = "encoder_model.ort";
  c.decoder_path = "decoder_model_merged.ort";
  assert(ValidateConfig(c) == 0);
  auto built = BuildRecognizerConfig(c, nullptr, nullptr);
  assert(std::string(built.model_config.moonshine.merged_decoder) == c.decoder_path);
  assert(std::string(built.model_config.moonshine.preprocessor).empty());
  c.preprocessor_path = "v1.onnx";
  assert(ValidateConfig(c) != 0);
  c.decoder_path.clear();
  c.uncached_decoder_path = "uncached.onnx";
  c.cached_decoder_path = "cached.onnx";
  assert(ValidateConfig(c) == 0);
  built = BuildRecognizerConfig(c, nullptr, nullptr);
  assert(std::string(built.model_config.moonshine.merged_decoder).empty());
}
