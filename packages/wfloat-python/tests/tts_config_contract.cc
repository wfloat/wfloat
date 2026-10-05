// Exercise actual core create/synthesize/dialogue code with a recording Sherpa
// backend. No model files, inference kernels, or native runtime build required.
#include <cassert>
#include "wfloat_tts.cc"

namespace sherpa_onnx {
class OfflineTtsImpl {};
static float seen_silence;
static float seen_speed;
static int32_t seen_sid;
static int calls;

bool OfflineTtsConfig::Validate() const {
  return silence_scale >= .01f && silence_scale <= 10.f;
}
OfflineTts::OfflineTts(const OfflineTtsConfig &) {}
OfflineTts::~OfflineTts() = default;
int32_t OfflineTts::SampleRate() const { return 24000; }
int32_t OfflineTts::NumSpeakers() const { return 8; }
WfloatPreparedText OfflineTts::PrepareWfloatText(
    const std::string &text, const std::string &, float) const {
  return {{text}, {text}};
}
GeneratedAudio OfflineTts::Generate(const std::string &, const GenerationConfig &cfg,
                                    GeneratedAudioCallback callback) const {
  seen_silence = cfg.silence_scale;
  seen_speed = cfg.speed;
  seen_sid = cfg.sid;
  ++calls;
  GeneratedAudio audio;
  audio.sample_rate = 24000;
  audio.samples = {.25f, .5f};
  if (callback) callback(audio.samples.data(), audio.samples.size(), 1);
  return audio;
}
}  // namespace sherpa_onnx

int main() {
  const wfloat_tts_family_t families[] = {
      WFLOAT_TTS_FAMILY_WFLOAT_EXPRESSIVE, WFLOAT_TTS_FAMILY_PIPER,
      WFLOAT_TTS_FAMILY_MATCHA, WFLOAT_TTS_FAMILY_KOKORO,
      WFLOAT_TTS_FAMILY_ZIPVOICE, WFLOAT_TTS_FAMILY_KITTEN,
      WFLOAT_TTS_FAMILY_POCKET};
  for (auto family : families) {
    for (float scale : {1.f, .5f}) {
      wfloat_tts_model_config_t config{};
      config.family = family;
      config.silence_scale = scale;
      wfloat_tts_model_t *model = nullptr;
      assert(wfloat_tts_model_create(&config, &model) == WFLOAT_STATUS_OK);
      config.silence_scale = 3.f;  // Model must retain its validated own value.
      const float expected = family == WFLOAT_TTS_FAMILY_KITTEN ? scale : .2f;
      wfloat_tts_synthesize_options_t options{};
      options.text = "Price $12.50. Don't split!";
      options.sid = 4;
      options.speed = 1.25f;
      // Check generation with and without native progress callbacks.
      for (bool progress : {false, true}) {
        wfloat_tts_synthesis_result_t *result = nullptr;
        wfloat_tts_progress_callback_t cb = progress ?
            +[](const wfloat_tts_progress_event_t *, void *) -> int32_t { return 1; } : nullptr;
        int before = sherpa_onnx::calls;
        assert(wfloat_tts_model_synthesize(model, &options, cb, nullptr, &result) == WFLOAT_STATUS_OK);
        assert(sherpa_onnx::calls == before + 1);
        assert(sherpa_onnx::seen_silence == expected);
        assert(sherpa_onnx::seen_speed == 1.25f && sherpa_onnx::seen_sid == 4);
        wfloat_tts_synthesis_result_destroy(result);
      }
      wfloat_tts_dialogue_segment_t segment{};
      segment.text = options.text;
      segment.sid = options.sid;
      segment.speed = options.speed;
      wfloat_tts_dialogue_options_t dialogue{};
      dialogue.segments = &segment;
      dialogue.segment_count = 1;
      wfloat_tts_synthesis_result_t *result = nullptr;
      int before = sherpa_onnx::calls;
      assert(wfloat_tts_model_synthesize_dialogue(model, &dialogue, nullptr, nullptr, &result) == WFLOAT_STATUS_OK);
      assert(sherpa_onnx::calls == before + 1);
      assert(sherpa_onnx::seen_silence == expected);
      assert(sherpa_onnx::seen_speed == 1.25f && sherpa_onnx::seen_sid == 4);
      wfloat_tts_synthesis_result_destroy(result);
      wfloat_tts_model_destroy(model);
    }
  }
}
