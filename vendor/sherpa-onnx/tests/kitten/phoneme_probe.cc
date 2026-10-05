// Differential test helper: links an already built eSpeak dependency.
#include <codecvt>
#include <iostream>
#include <locale>
#include <sstream>
#include <espeak-ng/speak_lib.h>
#include "sherpa-onnx/csrc/offline-tts-kitten-phonemize.h"
int main(int argc, char **argv) {
  if (argc != 2) return 2;
  if (espeak_Initialize(AUDIO_OUTPUT_SYNCHRONOUS, 0, argv[1], 0) <= 0) return 3;
  if (espeak_SetVoiceByName("en-us") != EE_OK) return 4;
  std::wstring_convert<std::codecvt_utf8<char32_t>, char32_t> utf8;
  std::string line;
  while (std::getline(std::cin, line)) {
    std::u32string text; uint32_t cp; std::istringstream input(line);
    while (input >> std::hex >> cp) text.push_back(cp);
    auto out = sherpa_onnx::kitten_text::PhonemizePreservingPunctuation(text,
      [&](const std::u32string &part) {
        auto bytes = utf8.to_bytes(part); const void *cursor = bytes.c_str();
        std::u32string phones;
        while (cursor) {
          auto p = espeak_TextToPhonemes(&cursor, espeakCHARS_UTF8, ('_' << 8) | 2);
          if (p && *p) { if (!phones.empty()) phones += U' '; phones += utf8.from_bytes(p); }
        }
        return phones;
      });
    for (auto c : out) std::cout << std::hex << static_cast<uint32_t>(c) << ' ';
    std::cout << '\n';
  }
  espeak_Terminate();
}
