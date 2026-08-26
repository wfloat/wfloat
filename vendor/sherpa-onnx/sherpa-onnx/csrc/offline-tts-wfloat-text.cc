// sherpa-onnx/csrc/offline-tts-wfloat-text.cc
//
// Copyright (c) 2026 Wfloat

#include "sherpa-onnx/csrc/offline-tts-wfloat-text.h"

#include <array>
#include <cctype>
#include <cmath>
#include <functional>
#include <map>
#include <string>
#include <unordered_map>
#include <utility>
#include <vector>

#include "sherpa-onnx/csrc/offline-tts-impl.h"
#include "sherpa-onnx/csrc/text-utils.h"

namespace sherpa_onnx {

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

WfloatPreparedText PrepareWfloatText(const std::string &text,
                                     const std::string &emotion,
                                     float intensity) {
  return PrepareWfloatTextImpl(text, emotion, intensity, {});
}

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

}  // namespace sherpa_onnx
