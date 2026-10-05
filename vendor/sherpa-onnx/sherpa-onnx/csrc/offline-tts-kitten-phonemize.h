// Kitten 0.8 eSpeak input/output protocol. See WFLOAT_KITTEN_08.md.
// Keep source punctuation out of eSpeak and restore it before tokenization.
#ifndef SHERPA_ONNX_CSRC_OFFLINE_TTS_KITTEN_PHONEMIZE_H_
#define SHERPA_ONNX_CSRC_OFFLINE_TTS_KITTEN_PHONEMIZE_H_
#include "sherpa-onnx/csrc/offline-tts-kitten-text-unicode.h"
namespace sherpa_onnx { namespace kitten_text {
inline bool PreservedPunctuation(char32_t c) {
  return Text(U";:,.!?¡¿—…\"«»“”(){}[]").find(c) != Text::npos;
}
template <typename Phonemize>
inline Text PhonemizePreservingPunctuation(const Text &text, Phonemize phonemize) {
  Text out;
  for (size_t begin = 0; begin < text.size();) {
    if (PreservedPunctuation(text[begin])) { out += text[begin++]; continue; }
    size_t end = begin;
    while (end < text.size() && !PreservedPunctuation(text[end])) ++end;
    auto part = text.substr(begin, end - begin);
    size_t a = 0, b = part.size();
    while (a < b && KittenIsSpace(part[a])) ++a;
    while (b > a && KittenIsSpace(part[b - 1])) --b;
    out += part.substr(0, a);
    if (a < b) {
      auto phones = phonemize(part.substr(a, b - a));
      // eSpeak's '_' phone separator is absent from Kitten's final phoneme
      // string; stress and language flags remain. No NFD conversion.
      phones.erase(std::remove(phones.begin(), phones.end(), U'_'), phones.end());
      for (auto &c : phones) if (c == U'\n') c = U' ';
      out += Strip(phones);
    }
    out += part.substr(b);
    begin = end;
  }
  return out;
}
} }
#endif
