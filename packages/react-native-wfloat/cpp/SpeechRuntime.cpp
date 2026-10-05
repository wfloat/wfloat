#include "Backend.h"
#include "OrtAssets.h"
#include "sherpa-onnx/c-api/c-api.h"
#include "sherpa-onnx/csrc/vad-model.h"
#include <algorithm>
#include <array>
#include <cmath>
#include <climits>
#include <limits>
#include <cctype>
#include <mutex>
#include <regex>
#include <set>
#include <fstream>
#include <sstream>
#include <unistd.h>
#include "ZipformerVocabulary.h"

namespace wfloat_next {
namespace {
template<class T, void (*Destroy)(const T*)> using Owned = std::unique_ptr<const T, decltype(Destroy)>;
using TtsHandle = Owned<SherpaOnnxOfflineTts, SherpaOnnxDestroyOfflineTts>;
using OfflineHandle = Owned<SherpaOnnxOfflineRecognizer, SherpaOnnxDestroyOfflineRecognizer>;
using OnlineHandle = Owned<SherpaOnnxOnlineRecognizer, SherpaOnnxDestroyOnlineRecognizer>;
using StreamHandle = Owned<SherpaOnnxOnlineStream, SherpaOnnxDestroyOnlineStream>;
// eSpeak has process-global state. Serialize all Wfloat TTS native entrypoints,
// while retaining independent ONNX sessions and allowing STT/VAD/LLM concurrency.
std::mutex ttsMutex;
int threads(const Json& options) {
  int n = options.value("numThreads", 1);
  if (n <= 0 || n > 256) throw std::invalid_argument("numThreads must be in 1..256.");
  return n;
}
std::vector<float> samples(const Json& j) {
  const auto& a = j.at("samples");
  if (!a.is_array() || a.size() > INT_MAX) throw std::invalid_argument("Invalid PCM array.");
  std::vector<float> result;
  result.reserve(a.size());
  for (const auto& v : a) {
    if (!v.is_number()) throw std::invalid_argument("PCM must contain finite numbers.");
    float f = v.get<float>();
    if (!std::isfinite(f)) throw std::invalid_argument("PCM must contain finite numbers.");
    result.push_back(f);
  }
  return result;
}
std::string textField(const Json& j, const char* key) {
  auto text = j.at(key).get<std::string>();
  if (text.find('\0') != std::string::npos) throw std::invalid_argument("Text must not contain NUL.");
  return text;
}
size_t utf16Length(const std::string& s) {
  // JSON parsing already rejects malformed UTF-8; revalidate native output.
  size_t count = 0;
  for (size_t i = 0; i < s.size();) {
    auto lead = static_cast<unsigned char>(s[i]);
    size_t n = lead < 0x80 ? 1 : lead >= 0xc2 && lead <= 0xdf ? 2 : lead >= 0xe0 && lead <= 0xef ? 3 : lead >= 0xf0 && lead <= 0xf4 ? 4 : 0;
    if (!n || i + n > s.size()) throw std::runtime_error("Invalid UTF-8 in prepared text.");
    uint32_t cp = lead & (n == 1 ? 0x7f : (1u << (7 - n)) - 1);
    for (size_t k = 1; k < n; ++k) {
      auto c = static_cast<unsigned char>(s[i+k]);
      if ((c & 0xc0) != 0x80) throw std::runtime_error("Invalid UTF-8 continuation.");
      cp = (cp << 6) | (c & 0x3f);
    }
    if ((n == 2 && cp < 0x80) || (n == 3 && cp < 0x800) || (n == 4 && cp < 0x10000) ||
        cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) throw std::runtime_error("Invalid UTF-8 code point.");
    count += cp > 0xffff ? 2 : 1; i += n;
  }
  return count;
}
int voice(const Json& j) {
  if (!j.contains("voiceId")) return 0;
  const auto& v = j.at("voiceId");
  static const std::array<const char*,20> names = {"skilled_hero_man", "skilled_hero_woman", "fun_hero_man", "fun_hero_woman", "strong_hero_man", "strong_hero_woman", "mad_scientist_man", "mad_scientist_woman", "clever_villain_man", "clever_villain_woman", "narrator_man", "narrator_woman", "wise_elder_man", "wise_elder_woman", "outgoing_anime_man", "outgoing_anime_woman", "scary_villain_man", "scary_villain_woman", "news_reporter_man", "news_reporter_woman"};
  if (v.is_number_integer()) { int n = v.get<int>(); if (n >= 0 && n < 20) return n; }
  if (v.is_string()) for (size_t i = 0; i < names.size(); ++i) if (v == names[i]) return static_cast<int>(i);
  throw std::invalid_argument("Invalid Wfloat voiceId.");
}
// Split original UTF-8 at natural boundaries, retaining UTF-16 public offsets.
Json preparePocket(const std::string& text) {
  utf16Length(text);
  Json result = Json::array();
  size_t start = 0, offset = 0;
  while (start < text.size()) {
    size_t end = start, boundary = start, count = 0;
    while (end < text.size() && count < 200) {
      unsigned char c = text[end];
      size_t n = c < 0x80 ? 1 : c < 0xe0 ? 2 : c < 0xf0 ? 3 : 4;
      end += n; ++count;
      if (c < 0x80 && (std::isspace(c) || std::ispunct(c))) boundary = end;
      if (n == 3 && (text.substr(end-n,n) == "。" || text.substr(end-n,n) == "！" || text.substr(end-n,n) == "？")) boundary = end;
    }
    if (end < text.size() && boundary > start) end = boundary;
    auto unit = text.substr(start, end-start);
    size_t next = offset + utf16Length(unit);
    if (unit.find_first_not_of(" \t\r\n") != std::string::npos)
      result.push_back({{"text",unit},{"textStart",offset},{"textEnd",next}});
    start = end; offset = next;
  }
  return result;
}
int pocketInteger(const Json& j, const char* key, int fallback, int minimum) {
  if (!j.contains(key)) return fallback;
  const auto& v = j.at(key);
  if (!v.is_number() || !std::isfinite(v.get<double>()) || v.get<double>() < minimum ||
      v.get<double>() > INT_MAX || std::floor(v.get<double>()) != v.get<double>())
    throw std::invalid_argument(std::string(key) + " must be a valid int32.");
  return v.get<int>();
}
struct Tts final : Backend {
  TtsHandle engine{nullptr, SherpaOnnxDestroyOfflineTts};
  bool pocket = false, piper = false, kokoro = false, kitten = false, chinese = false;
  Json standardMetadata, loadRequest;
  int expectedSpeakers = 0;
  // Caller holds ttsMutex. FSTs are engine-wide; release the old session first.
  void openKokoro(bool useChinese) {
    engine.reset();
    const auto& j = loadRequest;
    auto model = asset(j, {"model_onnx"}), voices = asset(j, {"model_voices"});
    auto tokens = asset(j, {"model_tokens"}), data = asset(j, {"espeak_data", "dataDir"});
    auto lexicon = asset(j, {"lexicon_zh"});
    auto rules = asset(j, {"rule_date_zh"}) + "," + asset(j, {"rule_number_zh"}) + "," + asset(j, {"rule_phone_zh"});
    SherpaOnnxOfflineTtsConfig c{};
    c.model.kokoro.model = model.c_str(); c.model.kokoro.voices = voices.c_str();
    c.model.kokoro.tokens = tokens.c_str(); c.model.kokoro.data_dir = data.c_str();
    c.model.kokoro.lexicon = lexicon.c_str(); c.model.kokoro.lang = "en-us"; c.model.kokoro.length_scale = 1;
    c.model.num_threads = threads(j.value("options", Json::object())); c.model.provider = "cpu";
    c.max_num_sentences = 1; c.silence_scale = 1.f; c.rule_fsts = useChinese ? rules.c_str() : "";
    engine.reset(SherpaOnnxCreateOfflineTts(&c));
    if (!engine) throw std::runtime_error("Failed to create Kokoro TTS.");
    if (SherpaOnnxOfflineTtsSampleRate(engine.get()) != 24000 || SherpaOnnxOfflineTtsNumSpeakers(engine.get()) != 54) {
      engine.reset(); throw std::runtime_error("Kokoro runtime metadata does not match pinned export.");
    }
    chinese = useChinese;
  }
  static std::string kokoroLanguage(int sid) {
    if (sid < 0 || sid >= 54) throw std::invalid_argument("Invalid Kokoro voiceId.");
    if (sid < 20) return "en-us";
    if (sid < 28) return "en";
    if (sid < 30 || sid == 53) return "es";
    if (sid == 30) return "fr";
    if (sid < 35) return "hi";
    if (sid < 37) return "it";
    if (sid < 42) throw std::invalid_argument("Kokoro Japanese voices require a Japanese frontend.");
    return sid < 45 ? "pt" : "cmn";
  }
  std::vector<float> defaultReference;
  explicit Tts(const Json& j) {
    auto family = j.value("family", std::string("wfloat"));
    pocket = family == "pocket";
    piper = family == "piper"; kokoro = family == "kokoro";
    kitten = family == "kitten";
    if (kokoro) {
      if (j.value("modelId", std::string()) != "hexgrad/Kokoro-82M") throw std::invalid_argument("Unsupported Kokoro model.");
      loadRequest = j; expectedSpeakers = 54;
      std::lock_guard<std::mutex> lock(ttsMutex); openKokoro(false); return;
    }
    if (!pocket && !piper && !kitten && family != "wfloat" && family != "wfloat-tts") throw std::invalid_argument("Unsupported TTS family.");
    SherpaOnnxOfflineTtsConfig c{};
    std::string model, tokens, data, voices, main, flow, encoder, decoder, conditioner, vocab, scores;
    if (pocket) {
      main = asset(j, {"lm_main"}); flow = asset(j, {"lm_flow"});
      encoder = asset(j, {"encoder"}); decoder = asset(j, {"decoder"});
      conditioner = asset(j, {"text_conditioner"}); vocab = asset(j, {"vocab_json"}); scores = asset(j, {"token_scores_json"});
      c.model.pocket.lm_main = main.c_str(); c.model.pocket.lm_flow = flow.c_str();
      c.model.pocket.encoder = encoder.c_str(); c.model.pocket.decoder = decoder.c_str();
      c.model.pocket.text_conditioner = conditioner.c_str(); c.model.pocket.vocab_json = vocab.c_str(); c.model.pocket.token_scores_json = scores.c_str();
      c.model.pocket.voice_embedding_cache_capacity = 8;
      auto reference = asset(j, {"reference_audio"});
      Owned<SherpaOnnxWave, SherpaOnnxFreeWave> wave(SherpaOnnxReadWave(reference.c_str()), SherpaOnnxFreeWave);
      if (!wave || wave->sample_rate != 24000 || wave->num_samples <= 0 || wave->num_samples > 240000 || !wave->samples)
        throw std::invalid_argument("Pocket Alba reference must be mono 24kHz and at most 10 seconds.");
      defaultReference.assign(wave->samples, wave->samples + wave->num_samples);
      for (float value : defaultReference) if (!std::isfinite(value)) throw std::invalid_argument("Invalid Alba reference PCM.");
    } else if (kitten) {
      const auto id = j.value("modelId", std::string());
      if (id != "KittenML/kitten-tts-nano-0.8" && id != "KittenML/kitten-tts-mini-0.8")
        throw std::invalid_argument("Unsupported Kitten model.");
      expectedSpeakers = 8;
      model = asset(j, {"model_onnx"}); tokens = asset(j, {"model_tokens"});
      voices = asset(j, {"model_voices"}); data = asset(j, {"espeak_data", "dataDir"});
      c.model.kitten.model = model.c_str(); c.model.kitten.tokens = tokens.c_str();
      c.model.kitten.voices = voices.c_str(); c.model.kitten.data_dir = data.c_str();
      c.model.kitten.length_scale = 1;
    } else if (piper) {
      const auto id = j.value("modelId", std::string());
      const std::map<std::string, std::pair<int, std::string>> specs = {
        {"rhasspy/piper-en_US-lessac-medium", {1,"en-us"}}, {"rhasspy/piper-en_US-amy-medium", {1,"en-us"}},
        {"rhasspy/piper-en_GB-alba-medium", {1,"en-gb-x-rp"}}, {"rhasspy/piper-de_DE-thorsten-medium", {1,"de"}},
        {"rhasspy/piper-fr_FR-siwis-medium", {1,"fr"}}, {"rhasspy/piper-en_US-libritts-high", {904,"en-us"}},
        {"rhasspy/piper-en_US-ryan-medium", {1,"en-us"}}};
      auto spec = specs.find(id);
      if (spec == specs.end()) throw std::invalid_argument("Unsupported Piper model.");
      expectedSpeakers = spec->second.first;
      std::ifstream metadata(asset(j, {"model_config"})); metadata >> standardMetadata;
      const auto& m = standardMetadata;
      if (m.at("audio").at("sample_rate") != 22050 || m.at("num_speakers") != expectedSpeakers ||
          m.at("espeak").at("voice") != spec->second.second || !(m.value("phoneme_type", std::string()) == "espeak" || (id == "rhasspy/piper-en_US-libritts-high" && !m.contains("phoneme_type"))))
        throw std::invalid_argument("Piper metadata does not match selected model.");
      const auto& aliases = m.at("speaker_id_map");
      if (!aliases.is_object()) throw std::invalid_argument("Invalid Piper speaker_id_map.");
      for (const auto& value : aliases) if (!value.is_number_integer() || value.get<double>() < 0 || value.get<double>() >= expectedSpeakers)
        throw std::invalid_argument("Invalid Piper speaker_id_map.");
      for (const auto key : {"noise_scale", "noise_w", "length_scale"}) {
        const auto& v = m.at("inference").at(key);
        if (!v.is_number() || !std::isfinite(v.get<float>()) || v.get<float>() <= 0) throw std::invalid_argument("Invalid Piper inference metadata.");
      }
      model = asset(j, {"model_onnx"}); tokens = asset(j, {"model_tokens"}); data = asset(j, {"espeak_data", "dataDir"});
      c.model.vits.model = model.c_str(); c.model.vits.tokens = tokens.c_str(); c.model.vits.data_dir = data.c_str();
      c.model.vits.noise_scale = m.at("inference").at("noise_scale").get<float>();
      c.model.vits.noise_scale_w = m.at("inference").at("noise_w").get<float>();
      c.model.vits.length_scale = m.at("inference").at("length_scale").get<float>();
    } else {
      model = asset(j, {"model_onnx", "model"}); tokens = asset(j, {"model_tokens", "tokens"}); data = asset(j, {"espeak_data", "dataDir"});
      c.model.wfloat.model = model.c_str(); c.model.wfloat.tokens = tokens.c_str(); c.model.wfloat.data_dir = data.c_str();
      c.model.wfloat.noise_scale = .667f; c.model.wfloat.noise_scale_w = .8f; c.model.wfloat.length_scale = 1;
    }
    c.model.num_threads = threads(j.value("options", Json::object())); c.model.provider = "cpu";
    c.max_num_sentences = 1; c.silence_scale = kitten ? 1.f : .2f;
    std::lock_guard<std::mutex> lock(ttsMutex);
    engine.reset(SherpaOnnxCreateOfflineTts(&c));
    if (!engine) throw std::runtime_error("Failed to create TTS.");
    if ((piper || kitten) && (SherpaOnnxOfflineTtsSampleRate(engine.get()) != (kitten ? 24000 : 22050) || SherpaOnnxOfflineTtsNumSpeakers(engine.get()) != expectedSpeakers)) {
      engine.reset(); throw std::runtime_error("TTS runtime metadata does not match selected model.");
    }
  }
  ~Tts() override { std::lock_guard<std::mutex> lock(ttsMutex); engine.reset(); }
  Json info() const override {
    Json result = {{"sampleRate", SherpaOnnxOfflineTtsSampleRate(engine.get())}};
    if (piper || kokoro || kitten) result["numSpeakers"] = expectedSpeakers;
    if (piper) result["metadata"] = standardMetadata;
    return result;
  }
  Json request(const Json& j, const Emit&, const Cancel& cancel) override {
    const auto op = j.at("op").get<std::string>();
    if (op != "prepare" && op != "synthesize") throw std::invalid_argument("Unsupported TTS operation: " + op);
    auto text = textField(j, "text");
    if (pocket && op == "prepare") { checkCancelled(cancel); return preparePocket(text); }
    if ((piper || kokoro || kitten) && j.contains("referenceAudio")) throw std::invalid_argument("This model does not support referenceAudio.");
    if (kitten) {
      // Preserve raw text; the shared version-8 frontend owns normalization,
      // style selection, chunking, speed priors and per-inference tail trimming.
      utf16Length(text);  // Validate UTF-8 before counting codepoints.
      size_t codepoints = 0;
      for (unsigned char c : text) if ((c & 0xc0) != 0x80) ++codepoints;
      if (codepoints > 65536) throw std::invalid_argument("Kitten text exceeds 65536 codepoints per call.");
      if (op == "prepare") {
        checkCancelled(cancel);
        return text.empty() ? Json::array() : Json::array({{{"text", text}, {"textStart", 0}, {"textEnd", utf16Length(text)}}});
      }
    }
    if ((piper || kokoro) && op == "prepare") { checkCancelled(cancel); return preparePocket(text); }
    int sid = pocket || piper || kokoro || kitten ? 0 : voice(j);
    std::string language;
    if (piper || kokoro || kitten) {
      sid = pocketInteger(j, "voiceId", 0, 0);
      if (sid >= expectedSpeakers) throw std::invalid_argument("Invalid TTS voiceId.");
      if (kokoro) language = kokoroLanguage(sid);
    }
    auto emotion = j.value("emotion", std::string("neutral"));
    static const std::set<std::string> emotions = {"neutral", "joy", "sadness", "anger", "fear", "surprise", "dismissive", "confusion"};
    float intensity = j.value("intensity", .5f), speed = j.value("speed", 1.f);
    if (!pocket && (!emotions.count(emotion) || !std::isfinite(intensity) || intensity < 0 || intensity > 1 || !std::isfinite(speed) || speed <= 0))
      throw std::invalid_argument("Invalid emotion, intensity or speed.");
    std::lock_guard<std::mutex> lock(ttsMutex);
    checkCancelled(cancel);
    if (kokoro && (!engine || chinese != (language == "cmn"))) openKokoro(language == "cmn");
    if (op == "prepare") {
      Owned<char, SherpaOnnxOfflineTtsWfloatFreePreparedText> raw(
        SherpaOnnxOfflineTtsWfloatPrepareText(engine.get(), text.c_str(), emotion.c_str(), intensity), SherpaOnnxOfflineTtsWfloatFreePreparedText);
      if (!raw) throw std::runtime_error("TTS text preparation failed.");
      auto prepared = Json::parse(raw.get());
      const auto original = prepared.at("text").get<std::vector<std::string>>();
      const auto clean = prepared.at("text_clean").get<std::vector<std::string>>();
      if (original.size() != clean.size()) throw std::runtime_error("TTS text alignment mismatch.");
      Json result = Json::array(); size_t cursor = 0; std::string joined;
      for (size_t i = 0; i < original.size(); ++i) {
        size_t end = cursor + utf16Length(original[i]); joined += original[i];
        result.push_back({{"text", clean[i]}, {"textStart", cursor}, {"textEnd", end}}); cursor = end;
      }
      if (joined != text) throw std::runtime_error("TTS original text does not match input.");
      checkCancelled(cancel); return result;
    }
    // Kitten receives raw text; other families receive their prepared unit.
    SherpaOnnxGenerationConfig config{}; config.sid = sid; config.speed = speed;
    if (kitten || kokoro) config.silence_scale = 1;
    std::vector<float> reference;
    std::string extra;
    if (kokoro) { extra = Json{{"lang", language == "cmn" ? "en-us" : language}}.dump(); config.extra = extra.c_str(); }
    if (pocket) {
      if (j.contains("voiceId") && j.at("voiceId") != "alba") throw std::invalid_argument("Pocket voiceId must be alba.");
      if (j.contains("voiceId") && j.contains("referenceAudio")) throw std::invalid_argument("Pocket voiceId and referenceAudio are mutually exclusive.");
      const std::vector<float>* selected = &defaultReference;
      if (j.contains("referenceAudio")) {
        const auto& input = j.at("referenceAudio");
        reference = samples(input);
        if (input.at("sampleRate") != 24000 || reference.empty() || reference.size() > 240000)
          throw std::invalid_argument("Pocket reference must be mono 24kHz and at most 10 seconds.");
        selected = &reference;
      }
      const double suppliedTemperature = j.value("temperature", .7);
      const float temperature = static_cast<float>(suppliedTemperature);
      if (!std::isfinite(temperature) || suppliedTemperature < 0 || (suppliedTemperature > 0 && suppliedTemperature < std::numeric_limits<float>::min())) throw std::invalid_argument("Invalid Pocket temperature.");
      config.speed = 1;
      config.num_steps = pocketInteger(j, "inferenceSteps", 5, 1);
      Json controls = {{"temperature",temperature}};
      if (j.contains("seed")) controls["seed"] = pocketInteger(j, "seed", -1, 0);
      extra = controls.dump(); config.extra = extra.c_str();
      config.reference_audio = selected->data(); config.reference_audio_len = static_cast<int>(selected->size()); config.reference_sample_rate = 24000;
    }
    auto callback = [](const float*, int32_t, float, void* opaque) -> int32_t {
      try { const auto& fn = *static_cast<const Cancel*>(opaque); return !(fn && fn()); }
      catch (...) { return 0; }
    };
    Owned<SherpaOnnxGeneratedAudio, SherpaOnnxDestroyOfflineTtsGeneratedAudio> audio(
      SherpaOnnxOfflineTtsGenerateWithConfig(engine.get(), text.c_str(), &config, callback, const_cast<Cancel*>(&cancel)),
      SherpaOnnxDestroyOfflineTtsGeneratedAudio);
    checkCancelled(cancel);
    if (!audio || audio->n < 0 || (audio->n && !audio->samples) || audio->sample_rate <= 0)
      throw std::runtime_error("TTS synthesis failed.");
    if (kitten && (audio->n == 0 || audio->sample_rate != 24000)) throw std::runtime_error("Kitten synthesis returned empty or invalid audio.");
    Json pcm = Json::array();
    for (int i = 0; i < audio->n; ++i) {
      if (!std::isfinite(audio->samples[i])) throw std::runtime_error("TTS returned invalid PCM.");
      pcm.push_back(audio->samples[i]);
    }
    return {{"samples", pcm}, {"sampleRate", audio->sample_rate}};
  }
};

struct Vad final : Backend {
  std::unique_ptr<sherpa_onnx::VadModel> model;
  std::vector<float> input;
  int frame = 512, context = 0;
  bool failed = false;
  explicit Vad(const Json& j) {
    auto family = j.at("family").get<std::string>();
    auto path = asset(j, {"model", "model_onnx"});
    sherpa_onnx::VadModelConfig c;
    c.num_threads = threads(j.value("options", Json::object()));
    if (family == "silero-vad") { c.silero_vad.model = path; c.silero_vad.window_size = 512; }
    else if (family == "ten-vad") { c.ten_vad.model = path; c.ten_vad.window_size = 256; frame = 256; }
    else throw std::invalid_argument("Unsupported VAD family.");
    if (!c.Validate()) throw std::invalid_argument("Invalid VAD configuration.");
    model = sherpa_onnx::VadModel::Create(c);
    if (!model || model->WindowShift() != frame) throw std::runtime_error("Unsupported VAD window shift.");
    context = model->WindowSize() - frame;
    if (context != 0 && !(family == "silero-vad" && context == 64)) throw std::runtime_error("Unsupported VAD context.");
    input.resize(frame + context, 0);
  }
  Json info() const override { return {{"sampleRate",16000}, {"frameSize",frame}}; }
  Json request(const Json& j, const Emit&, const Cancel& cancel) override {
    const auto op = j.at("op").get<std::string>();
    if (op == "resetVad") {
      failed = true; model->Reset(); std::fill(input.begin(), input.end(), 0); failed = false; return nullptr;
    }
    if (op != "scoreVad") throw std::invalid_argument("Unsupported VAD operation: " + op);
    if (failed) throw std::runtime_error("VAD inference failed; reset or unload before scoring.");
    auto pcm = samples(j);
    if (pcm.size() != static_cast<size_t>(frame)) throw std::invalid_argument("VAD requires exactly one frame.");
    checkCancelled(cancel);
    try {
      std::copy(pcm.begin(), pcm.end(), input.begin() + context);
      float score = model->Compute(input.data(), static_cast<int>(input.size()));
      if (!std::isfinite(score) || score < 0 || score > 1) throw std::runtime_error("Invalid VAD probability.");
      std::copy(pcm.end() - context, pcm.end(), input.begin());
      checkCancelled(cancel); return score;
    } catch (...) { failed = true; throw; }
  }
};

std::string hotwords(const Json& options) {
  std::set<std::string> seen; std::string result;
  if (!options.contains("hotwords")) return result;
  if (!options.at("hotwords").is_array()) throw std::invalid_argument("hotwords must be an array.");
  for (const auto& word : options.at("hotwords")) {
    auto raw = word.get<std::string>(); std::string normalized; bool space = false, letter = false;
    for (unsigned char c : raw) {
      if (c == ' ' || c == '\t') { space = !normalized.empty(); continue; }
      if (!((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c == '\'')) throw std::invalid_argument("Invalid English hotword/control syntax.");
      if (space) normalized += ' '; space = false;
      letter |= c != '\'';
      normalized += (c >= 'a' && c <= 'z') ? c - 'a' + 'A' : c;
    }
    if (!letter) throw std::invalid_argument("Hotwords must contain English letters.");
    if (seen.insert(normalized).second) { if (!result.empty()) result += '\n'; result += normalized; }
  }
  return result;
}
struct TemporaryVocabulary {
  std::string path;
  TemporaryVocabulary(const std::string& tokens) {
    // Verify learned vocabulary corresponds exactly to these model token IDs.
    std::ifstream tokenFile(tokens); std::string line; size_t count = 0;
    while (std::getline(tokenFile, line)) {
      if (line.empty()) continue;
      std::istringstream fields(line); std::string piece, id, extra;
      if (!(fields >> piece >> id) || (fields >> extra) || count >= zipformerPieces().size() ||
          piece != zipformerPieces()[count] || id != std::to_string(count))
        throw std::invalid_argument("Hotword vocabulary does not match model tokens.");
      ++count;
    }
    if (count != zipformerPieces().size()) throw std::invalid_argument("Incomplete hotword token vocabulary.");
    auto name = tokens + ".wfloat-vocab-XXXXXX"; std::vector<char> writable(name.begin(), name.end()); writable.push_back(0);
    int fd = mkstemp(writable.data());
    if (fd < 0) throw std::runtime_error("Cannot stage hotword vocabulary beside tokens.");
    path = writable.data();
    const std::string data = zipformerVocabulary;
    size_t offset = 0;
    while (offset < data.size()) {
      auto n = write(fd, data.data() + offset, data.size() - offset);
      if (n <= 0) { close(fd); unlink(path.c_str()); throw std::runtime_error("Cannot write hotword vocabulary."); }
      offset += static_cast<size_t>(n);
    }
    close(fd);
  }
  ~TemporaryVocabulary() { if (!path.empty()) unlink(path.c_str()); }
};
struct Stt final : Backend {
  Json load, options;
  // Declared before handles so sessions/streams close before aliases disappear.
  std::unique_ptr<OrtAssetPath> ortEncoder, ortDecoder;
  std::string family;
  OfflineHandle offline{nullptr, SherpaOnnxDestroyOfflineRecognizer};
  OnlineHandle online{nullptr, SherpaOnnxDestroyOnlineRecognizer};
  StreamHandle stream{nullptr, SherpaOnnxDestroyOnlineStream};
  bool finished = false, failed = false;
  explicit Stt(const Json& j) : load(j), family(j.at("family").get<std::string>()) {
    if (family == "moonshine" && j.value("modelId", std::string()) == "moonshine-ai/moonshine-base") {
      ortEncoder = std::make_unique<OrtAssetPath>(asset(j, {"encoder"}));
      ortDecoder = std::make_unique<OrtAssetPath>(asset(j, {"merged_decoder"}));
      load["paths"]["encoder"] = ortEncoder->path();
      load["paths"]["merged_decoder"] = ortDecoder->path();
    }
    configure(j.value("options", Json::object()));
  }
  Json info() const override { return {{"sampleRate", 16000}, {"kind", online ? "online" : "offline"}}; }
  void configure(const Json& next) {
    if (!next.is_object()) throw std::invalid_argument("STT options must be an object.");
    if (stream) throw std::invalid_argument("Cannot configure an open STT stream.");
    const auto id = load.value("modelId", std::string());
    const bool multilingual = family == "whisper" && (id == "openai/whisper-tiny" || id == "openai/whisper-base" || id == "openai/whisper-small");
    const bool french = id == "shaojieli/streaming-zipformer-fr";
    const bool bilingual = id == "k2-fsa/streaming-zipformer-zh-en";
    const bool englishHotwords = family == "zipformer-transducer" && (id.empty() || id == "k2-fsa/streaming-zipformer-en");
    std::string language = multilingual ? "" : "en";
    if (next.contains("language")) {
      if (family == "parakeet-tdt") throw std::invalid_argument("Parakeet detects language automatically; omit language.");
      language = next.at("language").get<std::string>();
      if (!std::regex_match(language, std::regex("[a-z]{2,3}([-_][a-z0-9]{2,8})*", std::regex::icase))) throw std::invalid_argument("Invalid STT language code.");
      std::transform(language.begin(), language.end(), language.begin(), [](unsigned char c){ return std::tolower(c); });
      language = language.substr(0, language.find_first_of("-_"));
      static const std::set<std::string> whisperLanguages = {"hi", "cy", "oc", "so", "fr", "az", "eu", "ba", "no", "as", "nl", "bn", "es", "ml", "km", "mk", "sq", "mt", "et", "ms", "tr", "bg", "ps", "br", "ht", "tt", "tk", "la", "de", "ur", "ro", "fa", "uk", "mg", "lo", "sr", "yo", "id", "da", "pt", "nn", "sn", "sa", "sd", "gl", "ja", "pl", "ru", "ko", "ne", "kn", "zh", "be", "ca", "el", "it", "hu", "lt", "ta", "is", "jw", "fi", "bo", "sv", "mi", "hr", "bs", "yi", "sk", "lv", "af", "vi", "ha", "mn", "cs", "sl", "pa", "su", "ka", "ln", "lb", "sw", "en", "tl", "hy", "te", "he", "my", "haw", "fo", "kk", "si", "tg", "th", "ar", "am", "mr", "uz", "gu"};
      const bool supported = multilingual ? whisperLanguages.count(language) != 0 : french ? language == "fr" : bilingual ? (language == "zh" || language == "en") : language == "en";
      if (!supported) throw std::invalid_argument("Language is incompatible with this STT model.");
    }
    const auto task = next.value("task", std::string("transcribe"));
    if (task != "transcribe" && !(multilingual && task == "translate")) throw std::invalid_argument("Unsupported transcription task for this model.");
    if (next.contains("timestamps") && (family != "whisper" || next.at("timestamps") != "segment")) throw std::invalid_argument("Requested STT timestamps are not exposed by this adapter.");
    if (next.contains("hotwords") && !englishHotwords) throw std::invalid_argument("Hotwords require the English Zipformer model.");
    // Compare effective engine settings: translation must trigger reconfiguration;
    // compatibility-only Zipformer language hints must not reload the recognizer.
    Json effective = next;
    effective["task"] = task;
    if (family == "whisper") effective["language"] = language;
    else effective.erase("language");
    if ((offline || online) && effective == options) return;
    auto tokens = asset(load, {"tokens", "model_tokens"}); auto encoder = asset(load, {"encoder"});
    if (family == "zipformer-transducer") {
      auto decoder = asset(load, {"decoder"}), joiner = asset(load, {"joiner"});
      auto words = hotwords(next); std::unique_ptr<TemporaryVocabulary> vocab;
      if (!words.empty()) vocab = std::make_unique<TemporaryVocabulary>(tokens);
      SherpaOnnxOnlineRecognizerConfig c{};
      c.feat_config.sample_rate = 16000; c.feat_config.feature_dim = 80;
      c.model_config.transducer.encoder = encoder.c_str(); c.model_config.transducer.decoder = decoder.c_str(); c.model_config.transducer.joiner = joiner.c_str();
      c.model_config.tokens = tokens.c_str(); c.model_config.num_threads = threads(next); c.model_config.provider = "cpu";
      if (french || bilingual) c.model_config.model_type = "zipformer";
      if (vocab) { c.model_config.modeling_unit = "bpe"; c.model_config.bpe_vocab = vocab->path.c_str(); }
      c.decoding_method = words.empty() ? "greedy_search" : "modified_beam_search"; c.max_active_paths = 4;
      c.enable_endpoint = 1; c.rule1_min_trailing_silence = 2.4f; c.rule2_min_trailing_silence = 1.2f; c.rule3_min_utterance_length = 20;
      c.hotwords_score = englishHotwords ? 1.5f : 0; c.hotwords_buf = words.c_str(); c.hotwords_buf_size = static_cast<int>(words.size());
      OnlineHandle replacement(SherpaOnnxCreateOnlineRecognizer(&c), SherpaOnnxDestroyOnlineRecognizer);
      if (!replacement) throw std::runtime_error("Failed to create Zipformer recognizer.");
      online = std::move(replacement);
    } else {
      SherpaOnnxOfflineRecognizerConfig c{};
      c.feat_config.sample_rate = 16000; c.feat_config.feature_dim = 80;
      c.model_config.tokens = tokens.c_str(); c.model_config.num_threads = threads(next); c.model_config.provider = "cpu";
      c.decoding_method = "greedy_search"; c.max_active_paths = 4;
      std::string decoder, preprocessor, uncached, cached, joiner, merged;
      if (family == "whisper") {
        decoder = asset(load, {"decoder"}); c.model_config.model_type = "whisper";
        c.model_config.whisper.encoder = encoder.c_str(); c.model_config.whisper.decoder = decoder.c_str();
        c.model_config.whisper.language = language.c_str(); c.model_config.whisper.task = task.c_str(); c.model_config.whisper.tail_paddings = -1;
        c.model_config.whisper.enable_segment_timestamps = next.value("timestamps", std::string()) == "segment";
      } else if (family == "parakeet-tdt") {
        decoder = asset(load, {"decoder"}); joiner = asset(load, {"joiner"});
        c.feat_config.feature_dim = 128; c.model_config.model_type = "nemo_transducer";
        c.model_config.transducer.encoder = encoder.c_str();
        c.model_config.transducer.decoder = decoder.c_str(); c.model_config.transducer.joiner = joiner.c_str();
      } else if (family == "moonshine") {
        if (id == "moonshine-ai/moonshine-base") {
          // v2 has raw-waveform encoder + merged decoder, never the v1 frontend.
          merged = asset(load, {"merged_decoder"});
        } else {
          preprocessor = asset(load, {"preprocessor"}); uncached = asset(load, {"uncached_decoder"}); cached = asset(load, {"cached_decoder"});
        }
        c.model_config.moonshine.merged_decoder = merged.c_str();
        c.model_config.moonshine.preprocessor = preprocessor.c_str(); c.model_config.moonshine.encoder = encoder.c_str();
        c.model_config.moonshine.uncached_decoder = uncached.c_str(); c.model_config.moonshine.cached_decoder = cached.c_str();
      } else throw std::invalid_argument("Unsupported STT family.");
      if (family == "whisper" && offline) {
        // Sherpa copies Whisper's language/task/timestamp config and applies it
        // to the decoder on the next DecodeStream. Keep the existing ORT arenas.
        SherpaOnnxOfflineRecognizerSetConfig(offline.get(), &c);
      } else {
        OfflineHandle replacement(SherpaOnnxCreateOfflineRecognizer(&c), SherpaOnnxDestroyOfflineRecognizer);
        if (!replacement) throw std::runtime_error("Failed to create offline recognizer.");
        offline = std::move(replacement);
      }
    }
    options = effective;
  }
  Json request(const Json& j, const Emit&, const Cancel& cancel) override {
    auto op = j.at("op").get<std::string>();
    if (op == "configure") { configure(j.at("options")); checkCancelled(cancel); return nullptr; }
    if (op == "closeStream") { stream.reset(); finished = failed = false; return nullptr; }
    if (op == "openStream") {
      if (!online || stream) throw std::invalid_argument("Online STT with no existing stream is required.");
      stream.reset(SherpaOnnxCreateOnlineStream(online.get()));
      if (!stream) throw std::runtime_error("Failed to create online STT stream.");
      finished = failed = false; return nullptr;
    }
    if (op == "resetStream") {
      if (!stream || finished || failed) throw std::invalid_argument("STT stream is absent, finished or failed.");
      SherpaOnnxOnlineStreamReset(online.get(), stream.get()); return nullptr;
    }
    if (op != "transcribe" && op != "pushStream") throw std::invalid_argument("Unsupported STT operation: " + op);
    auto pcm = samples(j); checkCancelled(cancel);
    if (op == "pushStream") {
      if (!stream || finished || failed) throw std::invalid_argument("STT stream is absent, finished or failed.");
      try {
        if (!pcm.empty()) SherpaOnnxOnlineStreamAcceptWaveform(stream.get(), 16000, pcm.data(), static_cast<int>(pcm.size()));
        if (j.value("finish", false)) {
          finished = true; std::vector<float> padding(16000, 0);
          SherpaOnnxOnlineStreamAcceptWaveform(stream.get(), 16000, padding.data(), static_cast<int>(padding.size()));
          SherpaOnnxOnlineStreamInputFinished(stream.get());
        }
        while (SherpaOnnxIsOnlineStreamReady(online.get(), stream.get())) {
          checkCancelled(cancel); SherpaOnnxDecodeOnlineStream(online.get(), stream.get());
        }
        checkCancelled(cancel);
        Owned<SherpaOnnxOnlineRecognizerResult, SherpaOnnxDestroyOnlineRecognizerResult> result(SherpaOnnxGetOnlineStreamResult(online.get(), stream.get()), SherpaOnnxDestroyOnlineRecognizerResult);
        if (!result || !result->text) throw std::runtime_error("Missing online STT result.");
        return {{"text",result->text}, {"isEndpoint",SherpaOnnxOnlineStreamIsEndpoint(online.get(), stream.get()) != 0}};
      } catch (...) { failed = true; throw; }
    }
    if (!offline) throw std::invalid_argument("Online STT requires a stream.");
    if (pcm.empty() || pcm.size() > 25 * 16000) throw std::invalid_argument("Offline STT requires 0 < duration <= 25 seconds at 16kHz.");
    if (std::all_of(pcm.begin(), pcm.end(), [](float x){ return x == 0; })) return {{"text", ""}};
    Owned<SherpaOnnxOfflineStream, SherpaOnnxDestroyOfflineStream> local(SherpaOnnxCreateOfflineStream(offline.get()), SherpaOnnxDestroyOfflineStream);
    if (!local) throw std::runtime_error("Failed to create offline STT stream.");
    SherpaOnnxAcceptWaveformOffline(local.get(), 16000, pcm.data(), static_cast<int>(pcm.size()));
    SherpaOnnxDecodeOfflineStream(offline.get(), local.get()); checkCancelled(cancel);
    Owned<SherpaOnnxOfflineRecognizerResult, SherpaOnnxDestroyOfflineRecognizerResult> result(SherpaOnnxGetOfflineStreamResult(local.get()), SherpaOnnxDestroyOfflineRecognizerResult);
    if (!result || !result->text) throw std::runtime_error("Missing offline STT result.");
    Json output = {{"text", result->text}};
    if (options.value("timestamps", std::string()) == "segment") {
      bool nonempty = std::string(result->text).find_first_not_of(" \t\n\r") != std::string::npos;
      if (result->segment_count <= 0) {
        if (nonempty) throw std::runtime_error("Requested segment timestamps were not returned.");
        return output;
      }
      if (!result->segment_texts_arr || !result->segment_timestamps || !result->segment_durations) throw std::runtime_error("Missing segment timing arrays.");
      output["segments"] = Json::array();
      for (int i = 0; i < result->segment_count; ++i) {
        double start = result->segment_timestamps[i] * 1000.0, end = start + result->segment_durations[i] * 1000.0;
        const char* text = result->segment_texts_arr[i];
        const bool hasText = text && std::string(text).find_first_not_of(" \t\n\r") != std::string::npos;
        if (!text || !std::isfinite(start) || !std::isfinite(end) || start < 0 || end < start ||
            (hasText && end == start))
          throw std::runtime_error("Invalid or unclosed Whisper segment timing.");
        // Clamp in this decoded window's coordinates, before JS adds its offset.
        const double durationMs = pcm.size() / 16.0;
        end = std::min(end, durationMs);
        if (start > durationMs || (hasText && end <= start))
          throw std::runtime_error("Invalid or unclosed Whisper segment timing.");
        output["segments"].push_back({{"text", text}, {"timing", {{"startMs",start}, {"endMs",end}}}});
      }
    }
    return output;
  }
};
}
std::unique_ptr<Backend> makeSpeech(const Json& j, const Cancel& cancel) {
  checkCancelled(cancel); std::unique_ptr<Backend> result;
  auto task = j.at("task").get<std::string>();
  if (task == "tts") result = std::make_unique<Tts>(j);
  else if (task == "stt") result = std::make_unique<Stt>(j);
  else if (task == "vad") result = std::make_unique<Vad>(j);
  else throw std::invalid_argument("Unknown speech task.");
  checkCancelled(cancel); return result;
}
}
