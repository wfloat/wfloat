// Source-only handoff probe. Build/run only when the parent authorizes native
// validation; no ONNX, eSpeak or model execution is needed for this probe.
#include <iostream>
#include <sstream>
#include "sherpa-onnx/csrc/offline-tts-kitten-text.h"
#include "sherpa-onnx/csrc/offline-tts-kitten-phonemize.h"
using namespace sherpa_onnx::kitten_text;
void Print(const Text &s) {
  for (auto c : s) std::cout << std::hex << static_cast<uint32_t>(c) << ' ';
}
int main(int argc, char **argv) {
  if (argc != 2) return 2;
  std::string mode = argv[1], line;
  while (std::getline(std::cin, line)) {
    Text text; uint32_t cp; std::istringstream input(line);
    while (input >> std::hex >> cp) text.push_back(cp);
    try {
      if (mode.rfind("rx:", 0) == 0) {
        size_t budget = 10000000;
        for (size_t pos = 0; pos < text.size();) {
          Match match;
          if (!MatchAt(std::stoi(mode.substr(3)), text, pos, &match, &budget)) { ++pos; continue; }
          for (auto index : match.spans) {
            if (index == Text::npos) std::cout << "-";
            else std::cout << std::dec << index;
            std::cout << ',';
          }
          std::cout << '|'; pos = match.spans[1];
        }
      }
      else if (mode == "float") Print(PythonFloatString(text));
      else if (mode == "norm") Print(Normalize(text));
      else if (mode == "nfc") Print(Nfc(text));
      else if (mode == "lower") Print(Lower(text));
      else if (mode == "chunks") {
        for (auto &chunk : Prepare(text)) { Print(chunk); std::cout << '|'; }
      } else if (mode == "punctuation") {
        Print(PhonemizePreservingPunctuation(text, [](const Text &part) {
          return U"_" + part + U"_";
        }));
      } else return 2;
      std::cout << '\n';
    } catch (const std::exception &ex) { std::cerr << ex.what() << "\n"; std::cout << "ERROR\n"; }
  }
}
