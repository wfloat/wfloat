// Wfloat Kitten overlay. Unicode 16.0.0 algorithms; data/license provenance in
// WFLOAT_KITTEN_08.md. No locale, platform wchar_t or runtime dependency.
#ifndef SHERPA_ONNX_CSRC_OFFLINE_TTS_KITTEN_TEXT_UNICODE_H_
#define SHERPA_ONNX_CSRC_OFFLINE_TTS_KITTEN_TEXT_UNICODE_H_
#include <algorithm>
#include <cstddef>
#include <string>
#include "sherpa-onnx/csrc/offline-tts-kitten-text-data.h"
#include "sherpa-onnx/csrc/offline-tts-kitten-unicode.h"
namespace sherpa_onnx { namespace kitten_text {
using Text = std::u32string;
template <size_t N>
inline const uint32_t *Lookup(const uint32_t (&table)[N], char32_t c,
                              size_t stride = 2) {
  size_t lo = 0, hi = N / stride;
  while (lo < hi) {
    size_t mid = lo + (hi - lo) / 2;
    if (table[mid * stride] < c) lo = mid + 1;
    else hi = mid;
  }
  return lo < N / stride && table[lo * stride] == c ? table + lo * stride : nullptr;
}
template <size_t N>
inline bool InRanges(const uint32_t (&table)[N], char32_t c) {
  size_t lo = 0, hi = N / 2;
  while (lo < hi) {
    size_t mid = lo + (hi - lo) / 2;
    if (table[mid * 2 + 1] < c) lo = mid + 1;
    else hi = mid;
  }
  return lo < N / 2 && table[lo * 2] <= c;
}
inline int Decimal(char32_t c) {
  auto p = Lookup(kDecimal, c);
  return p ? static_cast<int>(p[1]) : -1;
}
inline int Combining(char32_t c) {
  auto p = Lookup(kCombining, c);
  return p ? p[1] : 0;
}
inline char32_t Fold(char32_t c) {
  auto p = Lookup(kFold, c);
  return p ? p[1] : c;
}
inline void Decompose(char32_t c, Text *out) {
  if (c >= 0xac00 && c <= 0xd7a3) {
    auto index = c - 0xac00;
    out->push_back(0x1100 + index / 588);
    out->push_back(0x1161 + (index % 588) / 28);
    if (index % 28) out->push_back(0x11a7 + index % 28);
    return;
  }
  if (auto p = Lookup(kDecompose, c, 3)) {
    Decompose(p[1], out);
    if (p[2]) Decompose(p[2], out);
  } else out->push_back(c);
}
inline char32_t Compose(char32_t a, char32_t b) {
  if (a >= 0x1100 && a < 0x1113 && b >= 0x1161 && b < 0x1176)
    return 0xac00 + (a - 0x1100) * 588 + (b - 0x1161) * 28;
  if (a >= 0xac00 && a <= 0xd7a3 && (a - 0xac00) % 28 == 0 &&
      b > 0x11a7 && b < 0x11c3) return a + b - 0x11a7;
  size_t lo = 0, hi = sizeof(kCompose) / sizeof(*kCompose) / 3;
  const size_t end = hi;
  while (lo < hi) {
    size_t mid = lo + (hi - lo) / 2;
    auto p = kCompose + mid * 3;
    if (p[0] < a || (p[0] == a && p[1] < b)) lo = mid + 1;
    else hi = mid;
  }
  auto p = kCompose + lo * 3;
  return lo < end && p[0] == a && p[1] == b ? p[2] : 0;
}
inline Text Nfc(const Text &text) {
  Text decomposed;
  for (auto c : text) Decompose(c, &decomposed);
  for (size_t i = 0; i < decomposed.size();) {
    if (!Combining(decomposed[i])) { ++i; continue; }
    size_t end = i + 1;
    while (end < decomposed.size() && Combining(decomposed[end])) ++end;
    std::stable_sort(decomposed.begin() + i, decomposed.begin() + end,
                    [](char32_t a, char32_t b) { return Combining(a) < Combining(b); });
    i = end;
  }
  Text out;
  size_t starter = Text::npos;
  int last_class = 0;
  for (auto c : decomposed) {
    int cc = Combining(c);
    char32_t composed = starter != Text::npos ? Compose(out[starter], c) : 0;
    if (composed && (last_class == 0 || last_class < cc)) out[starter] = composed;
    else {
      if (cc == 0) starter = out.size();
      out.push_back(c);
      last_class = cc;
    }
  }
  return out;
}
inline Text Lower(const Text &text) {
  Text out;
  for (size_t i = 0; i < text.size(); ++i) {
    auto c = text[i];
    if (c == 0x3a3) {  // Unicode default Final_Sigma context rule.
      size_t before = i, after = i + 1;
      while (before && InRanges(kCaseIgnorable, text[before - 1])) --before;
      while (after < text.size() && InRanges(kCaseIgnorable, text[after])) ++after;
      bool final = before && InRanges(kCased, text[before - 1]) &&
                   (after == text.size() || !InRanges(kCased, text[after]));
      out.push_back(final ? 0x3c2 : 0x3c3);
    } else if (auto p = Lookup(kLower, c, 3)) {
      out.push_back(p[1]);
      if (p[2]) out.push_back(p[2]);
    } else out.push_back(c);
  }
  return out;
}
inline Text Strip(const Text &text) {
  size_t a = 0, b = text.size();
  while (a < b && KittenIsSpace(text[a])) ++a;
  while (b > a && KittenIsSpace(text[b - 1])) --b;
  return text.substr(a, b - a);
}
} }  // namespace sherpa_onnx::kitten_text
#endif
