#include "Backend.h"
#include "sherpa-onnx/c-api/c-api.h"
#include "sherpa-onnx/csrc/vad-model.h"
#include <algorithm>
#include <array>
#include <cmath>
#include <climits>
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
struct Tts final : Backend {
  TtsHandle engine{nullptr, SherpaOnnxDestroyOfflineTts};
  explicit Tts(const Json& j) {
    auto family = j.value("family", std::string("wfloat"));
    if (family != "wfloat" && family != "wfloat-tts") throw std::invalid_argument("Unsupported TTS family.");
    auto model = asset(j, {"model_onnx", "model"});
    auto tokens = asset(j, {"model_tokens", "tokens"});
    auto data = asset(j, {"espeak_data", "dataDir"});
    SherpaOnnxOfflineTtsConfig c{};
    c.model.wfloat.model = model.c_str(); c.model.wfloat.tokens = tokens.c_str();
    c.model.wfloat.data_dir = data.c_str();
    c.model.wfloat.noise_scale = .667f; c.model.wfloat.noise_scale_w = .8f; c.model.wfloat.length_scale = 1;
    c.model.num_threads = threads(j.value("options", Json::object())); c.model.provider = "cpu";
    c.max_num_sentences = 1; c.silence_scale = .2f;
    std::lock_guard<std::mutex> lock(ttsMutex);
    engine.reset(SherpaOnnxCreateOfflineTts(&c));
    if (!engine) throw std::runtime_error("Failed to create Wfloat TTS.");
  }
  ~Tts() override { std::lock_guard<std::mutex> lock(ttsMutex); engine.reset(); }
  Json info() const override { return {{"sampleRate", SherpaOnnxOfflineTtsSampleRate(engine.get())}}; }
  Json request(const Json& j, const Emit&, const Cancel& cancel) override {
    const auto op = j.at("op").get<std::string>();
    if (op != "prepare" && op != "synthesize") throw std::invalid_argument("Unsupported TTS operation: " + op);
    auto text = textField(j, "text");
    int sid = voice(j);
    auto emotion = j.value("emotion", std::string("neutral"));
    static const std::set<std::string> emotions = {"neutral", "joy", "sadness", "anger", "fear", "surprise", "dismissive", "confusion"};
    float intensity = j.value("intensity", .5f), speed = j.value("speed", 1.f);
    if (!emotions.count(emotion) || !std::isfinite(intensity) || intensity < 0 || intensity > 1 || !std::isfinite(speed) || speed <= 0)
      throw std::invalid_argument("Invalid emotion, intensity or speed.");
    std::lock_guard<std::mutex> lock(ttsMutex);
    checkCancelled(cancel);
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
    // text is the already prepared unit: never normalize it a second time.
    SherpaOnnxGenerationConfig config{}; config.sid = sid; config.speed = speed;
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
  std::string family;
  OfflineHandle offline{nullptr, SherpaOnnxDestroyOfflineRecognizer};
  OnlineHandle online{nullptr, SherpaOnnxDestroyOnlineRecognizer};
  StreamHandle stream{nullptr, SherpaOnnxDestroyOnlineStream};
  bool finished = false, failed = false;
  explicit Stt(const Json& j) : load(j), family(j.at("family").get<std::string>()) { configure(j.value("options", Json::object())); }
  Json info() const override { return {{"sampleRate", 16000}, {"kind", online ? "online" : "offline"}}; }
  void configure(const Json& next) {
    if (!next.is_object()) throw std::invalid_argument("STT options must be an object.");
    if (stream) throw std::invalid_argument("Cannot configure an open STT stream.");
    if (next.contains("language") && !std::regex_match(next.at("language").get<std::string>(), std::regex("en([-_][a-z0-9]{2,8})*", std::regex::icase))) throw std::invalid_argument("These STT models support English only.");
    if (next.value("task", std::string("transcribe")) != "transcribe") throw std::invalid_argument("Only transcription is supported.");
    if (next.contains("timestamps") && (family != "whisper" || next.at("timestamps") != "segment")) throw std::invalid_argument("Requested STT timestamps are unsupported.");
    if (next.contains("hotwords") && family != "zipformer-transducer") throw std::invalid_argument("Hotwords require Zipformer.");
    auto tokens = asset(load, {"tokens", "model_tokens"}); auto encoder = asset(load, {"encoder"});
    if (family == "zipformer-transducer") {
      auto decoder = asset(load, {"decoder"}), joiner = asset(load, {"joiner"});
      auto words = hotwords(next); std::unique_ptr<TemporaryVocabulary> vocab;
      if (!words.empty()) vocab = std::make_unique<TemporaryVocabulary>(tokens);
      SherpaOnnxOnlineRecognizerConfig c{};
      c.feat_config.sample_rate = 16000; c.feat_config.feature_dim = 80;
      c.model_config.transducer.encoder = encoder.c_str(); c.model_config.transducer.decoder = decoder.c_str(); c.model_config.transducer.joiner = joiner.c_str();
      c.model_config.tokens = tokens.c_str(); c.model_config.num_threads = threads(next); c.model_config.provider = "cpu";
      if (vocab) { c.model_config.modeling_unit = "bpe"; c.model_config.bpe_vocab = vocab->path.c_str(); }
      c.decoding_method = words.empty() ? "greedy_search" : "modified_beam_search"; c.max_active_paths = 4;
      c.enable_endpoint = 1; c.rule1_min_trailing_silence = 2.4f; c.rule2_min_trailing_silence = 1.2f; c.rule3_min_utterance_length = 20;
      c.hotwords_score = 1.5f; c.hotwords_buf = words.c_str(); c.hotwords_buf_size = static_cast<int>(words.size());
      OnlineHandle replacement(SherpaOnnxCreateOnlineRecognizer(&c), SherpaOnnxDestroyOnlineRecognizer);
      if (!replacement) throw std::runtime_error("Failed to create Zipformer recognizer.");
      online = std::move(replacement);
    } else {
      SherpaOnnxOfflineRecognizerConfig c{};
      c.feat_config.sample_rate = 16000; c.feat_config.feature_dim = 80;
      c.model_config.tokens = tokens.c_str(); c.model_config.num_threads = threads(next); c.model_config.provider = "cpu";
      c.decoding_method = "greedy_search"; c.max_active_paths = 4;
      std::string decoder, preprocessor, uncached, cached;
      if (family == "whisper") {
        decoder = asset(load, {"decoder"}); c.model_config.model_type = "whisper";
        c.model_config.whisper.encoder = encoder.c_str(); c.model_config.whisper.decoder = decoder.c_str();
        c.model_config.whisper.language = "en"; c.model_config.whisper.task = "transcribe"; c.model_config.whisper.tail_paddings = -1;
        c.model_config.whisper.enable_segment_timestamps = next.value("timestamps", std::string()) == "segment";
      } else if (family == "moonshine") {
        preprocessor = asset(load, {"preprocessor"}); uncached = asset(load, {"uncached_decoder"}); cached = asset(load, {"cached_decoder"});
        c.model_config.moonshine.preprocessor = preprocessor.c_str(); c.model_config.moonshine.encoder = encoder.c_str();
        c.model_config.moonshine.uncached_decoder = uncached.c_str(); c.model_config.moonshine.cached_decoder = cached.c_str();
      } else throw std::invalid_argument("Unsupported STT family.");
      OfflineHandle replacement(SherpaOnnxCreateOfflineRecognizer(&c), SherpaOnnxDestroyOfflineRecognizer);
      if (!replacement) throw std::runtime_error("Failed to create offline recognizer.");
      offline = std::move(replacement);
    }
    options = next;
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
        if (!text || !std::isfinite(start) || !std::isfinite(end) || start < 0 || end < start ||
            (std::string(text).find_first_not_of(" \t\n\r") != std::string::npos && end == start) || end > pcm.size() / 16.0 + 20)
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
