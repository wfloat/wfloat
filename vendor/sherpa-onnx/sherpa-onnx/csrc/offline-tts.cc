// sherpa-onnx/csrc/offline-tts.cc
//
// Copyright (c)  2023  Xiaomi Corporation

#include "sherpa-onnx/csrc/offline-tts.h"

#include <array>
#include <cctype>
#include <cmath>
#include <map>
#include <string>
#include <utility>
#include <vector>

#if __ANDROID_API__ >= 9
#include "android/asset_manager.h"
#include "android/asset_manager_jni.h"
#endif

#if __OHOS__
#include "rawfile/raw_file_manager.h"
#endif

#include "sherpa-onnx/csrc/file-utils.h"
#include "sherpa-onnx/csrc/macros.h"
#include "sherpa-onnx/csrc/offline-tts-impl.h"
#include "sherpa-onnx/csrc/text-utils.h"

namespace sherpa_onnx {

struct SilenceInterval {
  int32_t start;
  int32_t end;
};

namespace {

struct WfloatPlaceholderResult {
  std::string text;
  std::unordered_map<std::string, std::string> placeholders;
};

const std::vector<std::pair<std::string, std::string>> &GetWfloatAbbreviations() {
  static const std::vector<std::pair<std::string, std::string>>
      kAbbreviations = {
          {"Mr.", "Mister"},        {"Mrs.", "Misses"},
          {"Ms.", "Miz"},           {"Dr.", "Doctor"},
          {"St.", "Street"},        {"Mt.", "Mount"},
          {"Prof.", "Professor"},   {"Jr.", "Junior"},
          {"Sr.", "Senior"},        {"Inc.", "Inc"},
          {"vs.", "versus"},        {"etc.", "et cetera"},
          {"a.m.", "A M"},          {"A.M.", "A M"},
          {"p.m.", "P M"},          {"P.M.", "P M"},
          {"Capt.", "Captain"},     {"U.S.", "U S"},
          {"L.A.", "L A"},          {"U.K.", "U K"},
      };
  return kAbbreviations;
}

void ReplaceAll(std::string *s, const std::string &from,
                const std::string &to) {
  if (from.empty() || !s) {
    return;
  }

  size_t pos = 0;
  while ((pos = s->find(from, pos)) != std::string::npos) {
    s->replace(pos, from.size(), to);
    pos += to.size();
  }
}

int32_t ParsePlaceholderEnd(const std::string &s, size_t start,
                            const std::string &prefix) {
  if (start >= s.size() || s.compare(start, prefix.size(), prefix) != 0) {
    return -1;
  }

  size_t i = start + prefix.size();
  if (i >= s.size() || !std::isdigit(static_cast<unsigned char>(s[i]))) {
    return -1;
  }

  while (i < s.size() && std::isdigit(static_cast<unsigned char>(s[i]))) {
    ++i;
  }

  if (i + 1 < s.size() && s[i] == '_' && s[i + 1] == '_') {
    return static_cast<int32_t>(i + 2);
  }

  return -1;
}

WfloatPlaceholderResult ProtectDecimals(const std::string &s) {
  WfloatPlaceholderResult ans;
  ans.text.reserve(s.size());

  size_t i = 0;
  while (i < s.size()) {
    if (std::isdigit(static_cast<unsigned char>(s[i]))) {
      size_t j = i;
      while (j < s.size() && std::isdigit(static_cast<unsigned char>(s[j]))) {
        ++j;
      }

      if (j < s.size() && s[j] == '.' && j + 1 < s.size() &&
          std::isdigit(static_cast<unsigned char>(s[j + 1]))) {
        size_t k = j + 1;
        while (k < s.size() &&
               std::isdigit(static_cast<unsigned char>(s[k]))) {
          ++k;
        }

        std::string value = s.substr(i, k - i);
        std::string placeholder =
            "__DECIMAL_" + std::to_string(ans.placeholders.size()) + "__";
        ans.placeholders[placeholder] = value;
        ans.text.append(placeholder);
        i = k;
        continue;
      }
    }

    ans.text.push_back(s[i]);
    ++i;
  }

  return ans;
}

WfloatPlaceholderResult ProtectEllipsis(const std::string &s) {
  WfloatPlaceholderResult ans;
  ans.text.reserve(s.size());

  size_t i = 0;
  while (i < s.size()) {
    if (s[i] == '.') {
      size_t j = i;
      while (j < s.size() && s[j] == '.') {
        ++j;
      }

      if (j - i >= 3) {
        std::string value = s.substr(i, j - i);
        std::string placeholder =
            "__ELLIPSIS_" + std::to_string(ans.placeholders.size()) + "__";
        ans.placeholders[placeholder] = value;
        ans.text.append(placeholder);
      } else {
        ans.text.append(s.substr(i, j - i));
      }

      i = j;
      continue;
    }

    ans.text.push_back(s[i]);
    ++i;
  }

  return ans;
}

std::vector<std::string> SplitRawSentences(const std::string &s) {
  std::vector<std::string> sentences;
  size_t start = 0;
  size_t i = 0;
  size_t n = s.size();

  while (i < n) {
    if (i == start) {
      ++i;
      continue;
    }

    int32_t ellipsis_end = ParsePlaceholderEnd(s, i, "__ELLIPSIS_");
    if (ellipsis_end != -1) {
      size_t j = static_cast<size_t>(ellipsis_end);
      while (j < n && (s[j] == '!' || s[j] == '?')) {
        ++j;
      }

      sentences.push_back(s.substr(start, j - start));
      start = j;
      i = j;
      continue;
    }

    char ch = s[i];
    if (ch == '!' || ch == '?') {
      size_t j = i;
      while (j < n && (s[j] == '!' || s[j] == '?')) {
        ++j;
      }

      sentences.push_back(s.substr(start, j - start));
      start = j;
      i = j;
      continue;
    }

    if (ch == '.') {
      size_t j = i + 1;
      sentences.push_back(s.substr(start, j - start));
      start = j;
      i = j;
      continue;
    }

    ++i;
  }

  if (start < n) {
    sentences.push_back(s.substr(start));
  }

  return sentences;
}

std::string NormalizeEllipsis(const std::string &s) {
  std::string out;
  out.reserve(s.size());

  size_t i = 0;
  while (i < s.size()) {
    if (s[i] == '.') {
      size_t j = i;
      while (j < s.size() && s[j] == '.') {
        ++j;
      }

      if (j - i >= 3) {
        out.push_back('.');
      } else {
        out.append(s.substr(i, j - i));
      }

      i = j;
      continue;
    }

    out.push_back(s[i]);
    ++i;
  }

  return out;
}

std::string NormalizeInterrobangClusters(const std::string &s) {
  std::string out;
  out.reserve(s.size());

  size_t i = 0;
  while (i < s.size()) {
    if (s[i] == '!' || s[i] == '?') {
      size_t j = i;
      bool saw_bang = false;
      bool saw_q = false;
      while (j < s.size() && (s[j] == '!' || s[j] == '?')) {
        if (s[j] == '!') {
          saw_bang = true;
        } else {
          saw_q = true;
        }
        ++j;
      }

      if (saw_bang && saw_q) {
        out.push_back('?');
      } else if (saw_bang) {
        out.push_back('!');
      } else {
        out.push_back('?');
      }

      i = j;
      continue;
    }

    out.push_back(s[i]);
    ++i;
  }

  return out;
}

std::string RemoveDotBeforePunct(const std::string &s) {
  std::string out;
  out.reserve(s.size());

  size_t i = 0;
  while (i < s.size()) {
    if (s[i] == '.' && i + 1 < s.size() &&
        (s[i + 1] == '!' || s[i + 1] == '?')) {
      ++i;
      continue;
    }

    out.push_back(s[i]);
    ++i;
  }

  return out;
}

std::string NormalizeWhitespace(const std::string &s) {
  std::string out;
  out.reserve(s.size());

  bool prev_space = false;
  for (char ch : s) {
    if (ch == '\t' || ch == '\r' || ch == '\n') {
      ch = ' ';
    }

    if (ch == ' ') {
      if (prev_space) {
        continue;
      }

      prev_space = true;
      out.push_back(' ');
      continue;
    }

    prev_space = false;
    out.push_back(ch);
  }

  return out;
}

std::string Trim(const std::string &s) {
  if (s.empty()) {
    return s;
  }

  size_t begin = 0;
  while (begin < s.size() &&
         std::isspace(static_cast<unsigned char>(s[begin]))) {
    ++begin;
  }

  if (begin == s.size()) {
    return "";
  }

  size_t end = s.size();
  while (end > begin &&
         std::isspace(static_cast<unsigned char>(s[end - 1]))) {
    --end;
  }

  return s.substr(begin, end - begin);
}

std::string LStrip(const std::string &s) {
  if (s.empty()) {
    return s;
  }

  size_t begin = 0;
  while (begin < s.size() &&
         std::isspace(static_cast<unsigned char>(s[begin]))) {
    ++begin;
  }

  return s.substr(begin);
}

bool EndsWithEllipsis(const std::string &s) {
  if (s.empty()) {
    return false;
  }

  int32_t i = static_cast<int32_t>(s.size()) - 1;
  while (i >= 0 && std::isspace(static_cast<unsigned char>(s[i]))) {
    --i;
  }

  int32_t dot_count = 0;
  while (i >= 0 && s[i] == '.') {
    ++dot_count;
    --i;
  }

  return dot_count >= 3;
}

std::string UppercaseFirstAsciiAlpha(const std::string &s) {
  std::string out = s;
  for (size_t i = 0; i < out.size(); ++i) {
    char ch = out[i];
    if (ch >= 'a' && ch <= 'z') {
      out[i] = static_cast<char>(ch - 'a' + 'A');
      return out;
    }

    if (ch >= 'A' && ch <= 'Z') {
      return out;
    }
  }

  return out;
}

bool IsPunctOnlyChunk(const std::string &s) {
  size_t i = 0;
  while (i < s.size() && std::isspace(static_cast<unsigned char>(s[i]))) {
    ++i;
  }

  size_t j = i;
  while (j < s.size() && (s[j] == '!' || s[j] == '?')) {
    ++j;
  }

  if (j == i) {
    return false;
  }

  while (j < s.size() && std::isspace(static_cast<unsigned char>(s[j]))) {
    ++j;
  }

  return j == s.size();
}

bool EndsWithTerminalPunct(const std::string &s) {
  if (s.empty()) {
    return false;
  }

  int32_t i = static_cast<int32_t>(s.size()) - 1;
  while (i >= 0 && std::isspace(static_cast<unsigned char>(s[i]))) {
    --i;
  }

  if (i < 0) {
    return false;
  }

  return s[i] == '.' || s[i] == '!' || s[i] == '?';
}

WfloatPreparedText SplitIntoWfloatSentences(const std::string &text) {
  WfloatPreparedText ans;

  if (text.empty()) {
    return ans;
  }

  std::string protected_text = text;
  std::vector<std::string> abbreviation_placeholders;

  const auto &abbr = GetWfloatAbbreviations();
  abbreviation_placeholders.reserve(abbr.size());

  for (size_t i = 0; i < abbr.size(); ++i) {
    std::string placeholder = "__ABBR_" + std::to_string(i) + "__";
    std::string replacement = abbr[i].first;
    ReplaceAll(&replacement, ".", placeholder);
    ReplaceAll(&protected_text, abbr[i].first, replacement);
    abbreviation_placeholders.push_back(std::move(placeholder));
  }

  auto protected_decimals = ProtectDecimals(protected_text);
  protected_text = std::move(protected_decimals.text);

  auto protected_ellipsis = ProtectEllipsis(protected_text);
  protected_text = std::move(protected_ellipsis.text);

  auto raw_sentences = SplitRawSentences(protected_text);
  ans.text.reserve(raw_sentences.size());
  ans.text_clean.reserve(raw_sentences.size());

  for (const auto &chunk : raw_sentences) {
    std::string original_chunk = chunk;

    for (const auto &placeholder : abbreviation_placeholders) {
      ReplaceAll(&original_chunk, placeholder, ".");
    }

    for (const auto &kv : protected_decimals.placeholders) {
      ReplaceAll(&original_chunk, kv.first, kv.second);
    }

    for (const auto &kv : protected_ellipsis.placeholders) {
      ReplaceAll(&original_chunk, kv.first, kv.second);
    }

    ans.text.push_back(original_chunk);

    std::string clean_chunk = original_chunk;
    for (const auto &item : abbr) {
      ReplaceAll(&clean_chunk, item.first, item.second);
    }

    clean_chunk = NormalizeEllipsis(clean_chunk);
    clean_chunk = NormalizeInterrobangClusters(clean_chunk);
    clean_chunk = RemoveDotBeforePunct(clean_chunk);
    clean_chunk = NormalizeWhitespace(clean_chunk);
    ans.text_clean.push_back(std::move(clean_chunk));
  }

  for (size_t i = 0; i + 1 < ans.text_clean.size(); ++i) {
    if (EndsWithEllipsis(ans.text[i])) {
      std::string next_chunk = LStrip(ans.text_clean[i + 1]);
      if (!next_chunk.empty()) {
        next_chunk = UppercaseFirstAsciiAlpha(next_chunk);
      }
      ans.text_clean[i + 1] = std::move(next_chunk);
    }
  }

  size_t i = 1;
  while (i < ans.text.size()) {
    if (IsPunctOnlyChunk(ans.text[i])) {
      ans.text[i - 1] += ans.text[i];
      if (!EndsWithTerminalPunct(ans.text_clean[i - 1])) {
        ans.text_clean[i - 1] += ans.text_clean[i];
      }

      ans.text.erase(ans.text.begin() + static_cast<int32_t>(i));
      ans.text_clean.erase(ans.text_clean.begin() + static_cast<int32_t>(i));
      continue;
    }
    ++i;
  }

  while (ans.text.size() > 1 && Trim(ans.text.back()).empty()) {
    ans.text[ans.text.size() - 2] += ans.text.back();
    ans.text_clean[ans.text_clean.size() - 2] += ans.text_clean.back();
    ans.text.pop_back();
    ans.text_clean.pop_back();
  }

  for (auto &chunk : ans.text_clean) {
    chunk = Trim(chunk);
  }

  if (ans.text_clean.size() > 1 && ans.text_clean.back().empty()) {
    ans.text_clean.pop_back();
    ans.text.pop_back();
  }

  return ans;
}

float ClampUnitFloat(float v) {
  if (!std::isfinite(v)) {
    return 0.0f;
  }

  if (v < 0.0f) {
    return 0.0f;
  }

  if (v > 1.0f) {
    return 1.0f;
  }

  return v;
}

std::string ResolveEmotionEmoji(const std::string &emotion) {
  static const std::unordered_map<std::string, std::string> kEmotionToEmoji = {
      {"neutral", "😐"},   {"joy", "😄"},       {"sadness", "😢"},
      {"anger", "😡"},     {"fear", "😱"},      {"surprise", "😲"},
      {"dismissive", "🙄"}, {"confusion", "🤔"},
  };

  std::string key = ToLowerAscii(emotion);
  auto iter = kEmotionToEmoji.find(key);
  if (iter != kEmotionToEmoji.end()) {
    return iter->second;
  }

  return "😐";
}

std::string UnitFloatToPhoneme(float x) {
  static const std::array<const char *, 10> kPhonemes = {
      "⓪", "①", "②", "③", "④", "⑤", "⑥", "⑦", "⑧", "⑨",
  };

  float v = ClampUnitFloat(x);
  int32_t idx = static_cast<int32_t>(v * static_cast<float>(kPhonemes.size()));
  idx = std::max(0, std::min(idx, static_cast<int32_t>(kPhonemes.size() - 1)));
  return kPhonemes[idx];
}

WfloatPreparedText PrepareWfloatTextImpl(
    const std::string &text, const std::string &emotion, float intensity,
    const std::function<std::vector<std::string>(
        const std::vector<std::string> &)> &phoneme_converter) {
  WfloatPreparedText prepared = SplitIntoWfloatSentences(text);
  prepared.text_phonemes.resize(prepared.text_clean.size());

  bool add_terminal_punct_to_last = !prepared.text_clean.empty() &&
                                    !EndsWithTerminalPunct(
                                        prepared.text_clean.back());
  if (add_terminal_punct_to_last) {
    prepared.text_clean.back() += ".";
  }

  if (phoneme_converter) {
    auto phonemes = phoneme_converter(prepared.text_clean);
    size_t n = std::min(phonemes.size(), prepared.text_phonemes.size());
    for (size_t i = 0; i != n; ++i) {
      prepared.text_phonemes[i] = std::move(phonemes[i]);
    }
  }

  std::string suffix = ResolveEmotionEmoji(emotion) + UnitFloatToPhoneme(intensity);
  for (size_t i = 0; i != prepared.text_clean.size(); ++i) {
    if (add_terminal_punct_to_last && i + 1 == prepared.text_phonemes.size() &&
        !EndsWithTerminalPunct(prepared.text_phonemes[i])) {
      prepared.text_phonemes[i] += ".";
    }

    prepared.text_clean[i] += suffix;
    prepared.text_phonemes[i] += suffix;
  }

  return prepared;
}

}  // namespace

GeneratedAudio GeneratedAudio::ScaleSilence(float scale) const {
  if (scale == 1) {
    return *this;
  }
  // if the interval is larger than 0.2 second, then we assume it is a pause
  int32_t threshold = static_cast<int32_t>(sample_rate * 0.2);

  std::vector<SilenceInterval> intervals;
  int32_t num_samples = static_cast<int32_t>(samples.size());

  int32_t last = -1;
  int32_t i;
  for (i = 0; i != num_samples; ++i) {
    if (fabs(samples[i]) <= 0.01) {
      if (last == -1) {
        last = i;
      }
      continue;
    }

    if (last != -1 && i - last < threshold) {
      last = -1;
      continue;
    }

    if (last != -1) {
      intervals.push_back({last, i});
      last = -1;
    }
  }

  if (last != -1 && num_samples - last > threshold) {
    intervals.push_back({last, num_samples});
  }

  if (intervals.empty()) {
    return *this;
  }

  GeneratedAudio ans;
  ans.sample_rate = sample_rate;
  ans.samples.reserve(samples.size());

  i = 0;
  for (const auto &interval : intervals) {
    ans.samples.insert(ans.samples.end(), samples.begin() + i,
                       samples.begin() + interval.start);
    i = interval.end;
    int32_t n = static_cast<int32_t>((interval.end - interval.start) * scale);

    ans.samples.insert(ans.samples.end(), samples.begin() + interval.start,
                       samples.begin() + interval.start + n);
  }

  if (i < num_samples) {
    ans.samples.insert(ans.samples.end(), samples.begin() + i, samples.end());
  }

  return ans;
}

WfloatPreparedText PrepareWfloatText(const std::string &text,
                                     const std::string &emotion,
                                     float intensity) {
  return PrepareWfloatTextImpl(text, emotion, intensity, {});
}

std::string GenerationConfig::GetExtraString(
    const std::string &key, const std::string &def /*= ""*/) const {
  auto it = extra.find(key);
  return it == extra.end() ? def : it->second;
}

int32_t GenerationConfig::GetExtraInt(const std::string &key,
                                      int32_t def) const {
  auto it = extra.find(key);
  if (it == extra.end()) {
    return def;
  }

  return ToIntOrDefault(it->second, def);
}

float GenerationConfig::GetExtraFloat(const std::string &key, float def) const {
  auto it = extra.find(key);
  if (it == extra.end()) {
    return def;
  }

  return ToFloatOrDefault(it->second, def);
}

std::string GenerationConfig::ToString() const {
  std::ostringstream os;

  os << "GenerationConfig(";
  os << "silence_scale=" << silence_scale;
  os << ", speed=" << speed;
  os << ", sid=" << sid;
  os << ", num_steps=" << num_steps;
  os << ", reference_audio_len=" << reference_audio.size();
  os << ", reference_sample_rate=" << reference_sample_rate;

  if (!reference_text.empty()) {
    os << ", reference_text=\"" << reference_text << "\"";
  }

  if (!extra.empty()) {
    os << ", extra={";
    std::string sep;

    std::map<std::string, std::string> sorted(extra.begin(), extra.end());

    for (const auto &kv : sorted) {
      os << sep << kv.first << ": \"" << kv.second << "\"";
      sep = ", ";
    }
    os << "}";
  }

  os << ")";
  return os.str();
}

void OfflineTtsConfig::Register(ParseOptions *po) {
  model.Register(po);

  po->Register("tts-rule-fsts", &rule_fsts,
               "It not empty, it contains a list of rule FST filenames."
               "Multiple filenames are separated by a comma and they are "
               "applied from left to right. An example value: "
               "rule1.fst,rule2.fst,rule3.fst");

  po->Register("tts-rule-fars", &rule_fars,
               "It not empty, it contains a list of rule FST archive filenames."
               "Multiple filenames are separated by a comma and they are "
               "applied from left to right. An example value: "
               "rule1.far,rule2.far,rule3.far. Note that an *.far can contain "
               "multiple *.fst files");

  po->Register(
      "tts-max-num-sentences", &max_num_sentences,
      "Maximum number of sentences that we process at a time. "
      "This is to avoid OOM for very long input text. "
      "If you set it to -1, then we process all sentences in a single batch.");

  po->Register("tts-silence-scale", &silence_scale,
               "Duration of the pause is scaled by this number. So a smaller "
               "value leads to a shorter pause.");
}

bool OfflineTtsConfig::Validate() const {
  if (!rule_fsts.empty()) {
    std::vector<std::string> files;
    SplitStringToVector(rule_fsts, ",", false, &files);
    for (const auto &f : files) {
      if (!FileExists(f)) {
        SHERPA_ONNX_LOGE("Rule fst '%s' does not exist. ", f.c_str());
        return false;
      }
    }
  }

  if (!rule_fars.empty()) {
    std::vector<std::string> files;
    SplitStringToVector(rule_fars, ",", false, &files);
    for (const auto &f : files) {
      if (!FileExists(f)) {
        SHERPA_ONNX_LOGE("Rule far '%s' does not exist. ", f.c_str());
        return false;
      }
    }
  }

  if (silence_scale < 0.001) {
    SHERPA_ONNX_LOGE("--tts-silence-scale '%.3f' is too small", silence_scale);
    return false;
  }

  return model.Validate();
}

std::string OfflineTtsConfig::ToString() const {
  std::ostringstream os;

  os << "OfflineTtsConfig(";
  os << "model=" << model.ToString() << ", ";
  os << "rule_fsts=\"" << rule_fsts << "\", ";
  os << "rule_fars=\"" << rule_fars << "\", ";
  os << "max_num_sentences=" << max_num_sentences << ", ";
  os << "silence_scale=" << silence_scale << ")";

  return os.str();
}

OfflineTts::OfflineTts(const OfflineTtsConfig &config)
    : impl_(OfflineTtsImpl::Create(config)) {}

template <typename Manager>
OfflineTts::OfflineTts(Manager *mgr, const OfflineTtsConfig &config)
    : impl_(OfflineTtsImpl::Create(mgr, config)) {}

OfflineTts::~OfflineTts() = default;

GeneratedAudio OfflineTts::Generate(
    const std::string &text, int64_t sid /*=0*/, float speed /*= 1.0*/,
    GeneratedAudioCallback callback /*= nullptr*/) const {
#if !defined(_WIN32)
  return impl_->Generate(text, sid, speed, std::move(callback));
#else
  if (IsUtf8(text)) {
    return impl_->Generate(text, sid, speed, std::move(callback));
  } else if (IsGB2312(text)) {
    auto utf8_text = Gb2312ToUtf8(text);
    static bool printed = false;
    if (!printed) {
      SHERPA_ONNX_LOGE(
          "Detected GB2312 encoded string! Converting it to UTF8.");
      printed = true;
    }
    return impl_->Generate(utf8_text, sid, speed, std::move(callback));
  } else {
    SHERPA_ONNX_LOGE(
        "Non UTF8 encoded string is received. You would not get expected "
        "results!");
    return impl_->Generate(text, sid, speed, std::move(callback));
  }
#endif
}

GeneratedAudio OfflineTts::Generate(
    const std::string &text, const std::string &prompt_text,
    const std::vector<float> &prompt_samples, int32_t sample_rate,
    float speed /*=1.0*/, int32_t num_steps /*=4*/,
    GeneratedAudioCallback callback /*=nullptr*/) const {
#if !defined(_WIN32)
  return impl_->Generate(text, prompt_text, prompt_samples, sample_rate, speed,
                         num_steps, std::move(callback));
#else
  static bool printed = false;
  auto utf8_text = text;
  if (IsGB2312(text)) {
    utf8_text = Gb2312ToUtf8(text);
    if (!printed) {
      SHERPA_ONNX_LOGE("Detected GB2312 encoded text! Converting it to UTF8.");
      printed = true;
    }
  }
  auto utf8_prompt_text = prompt_text;
  if (IsGB2312(prompt_text)) {
    utf8_prompt_text = Gb2312ToUtf8(prompt_text);
    if (!printed) {
      SHERPA_ONNX_LOGE(
          "Detected GB2312 encoded prompt text! Converting it to UTF8.");
      printed = true;
    }
  }
  if (IsUtf8(utf8_text) && IsUtf8(utf8_prompt_text)) {
    return impl_->Generate(utf8_text, utf8_prompt_text, prompt_samples,
                           sample_rate, speed, num_steps, std::move(callback));
  } else {
    SHERPA_ONNX_LOGE(
        "Non UTF8 encoded string is received. You would not get expected "
        "results!");
    return impl_->Generate(utf8_text, utf8_prompt_text, prompt_samples,
                           sample_rate, speed, num_steps, std::move(callback));
  }
#endif
}

GeneratedAudio OfflineTts::Generate(
    const std::string &text, const GenerationConfig &config,
    GeneratedAudioCallback callback /*= nullptr*/) const {
#if !defined(_WIN32)
  return impl_->Generate(text, config, std::move(callback));
#else
  if (IsUtf8(text)) {
    return impl_->Generate(text, config, std::move(callback));
  } else if (IsGB2312(text)) {
    auto utf8_text = Gb2312ToUtf8(text);
    static bool printed = false;
    if (!printed) {
      SHERPA_ONNX_LOGE(
          "Detected GB2312 encoded string! Converting it to UTF8.");
      printed = true;
    }
    return impl_->Generate(utf8_text, config, std::move(callback));
  } else {
    SHERPA_ONNX_LOGE(
        "Non UTF8 encoded string is received. You would not get expected "
        "results!");
    return impl_->Generate(text, config, std::move(callback));
  }
#endif
}

int32_t OfflineTts::SampleRate() const { return impl_->SampleRate(); }

int32_t OfflineTts::NumSpeakers() const { return impl_->NumSpeakers(); }

std::vector<std::string> OfflineTts::ConvertTextToPhonemes(
    const std::vector<std::string> &text) const {
  return impl_->ConvertTextToPhonemes(text);
}

WfloatPreparedText OfflineTts::PrepareWfloatText(const std::string &text,
                                                 const std::string &emotion,
                                                 float intensity) const {
  return PrepareWfloatTextImpl(
      text, emotion, intensity,
      [this](const std::vector<std::string> &sentences) {
        return impl_->ConvertTextToPhonemes(sentences);
      });
}

#if __ANDROID_API__ >= 9
template OfflineTts::OfflineTts(AAssetManager *mgr,
                                const OfflineTtsConfig &config);
#endif

#if __OHOS__
template OfflineTts::OfflineTts(NativeResourceManager *mgr,
                                const OfflineTtsConfig &config);
#endif

}  // namespace sherpa_onnx
