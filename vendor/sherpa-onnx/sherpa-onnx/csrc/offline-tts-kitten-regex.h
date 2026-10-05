// Wfloat Kitten-only matcher for the fixed upstream preprocessing expressions.
// The generator rejects unsupported opcodes; this is not a public regex API.
// Explicit backtracking stack avoids recursion per consumed character.
#ifndef SHERPA_ONNX_CSRC_OFFLINE_TTS_KITTEN_REGEX_H_
#define SHERPA_ONNX_CSRC_OFFLINE_TTS_KITTEN_REGEX_H_
#include <array>
#include <stdexcept>
#include <vector>
#include "sherpa-onnx/csrc/offline-tts-kitten-regex-data.h"
#include "sherpa-onnx/csrc/offline-tts-kitten-text-unicode.h"
namespace sherpa_onnx { namespace kitten_text {
struct Match {
  std::array<size_t, 16> spans;
  Match() { spans.fill(Text::npos); }
  Text Group(const Text &text, size_t group = 0) const {
    auto a = spans.at(group * 2), b = spans.at(group * 2 + 1);
    return a == Text::npos || b == Text::npos ? Text() : text.substr(a, b - a);
  }
};
inline bool ClassMatches(const RegexOp &op, char32_t c) {
  bool found = false;
  for (int i = 0; i < op.b / 2; ++i) {
    const auto &entry = kRegexClasses[op.a + i];
    switch (entry.category) {
      case 0: {
        auto value = op.c ? Fold(c) : c;
        auto lo = op.c ? Fold(entry.lo) : entry.lo;
        auto hi = op.c ? Fold(entry.hi) : entry.hi;
        found |= value >= lo && value <= hi;
        break;
      }
      case 1: found |= Decimal(c) >= 0; break;
      case 2: found |= Decimal(c) < 0; break;
      case 3: found |= KittenIsSpace(c); break;
      case 4: found |= !KittenIsSpace(c); break;
      case 5: found |= KittenIsWord(c); break;
      case 6: found |= !KittenIsWord(c); break;
    }
  }
  return found != static_cast<bool>(op.b % 2);
}
inline bool MatchAt(int entry, const Text &text, size_t start, Match *result,
                    size_t *budget) {
  struct State { int pc; size_t pos; Match captures; };
  State state{entry, start, {}};
  std::vector<State> stack;
  for (;;) {
    if (*budget == 0) throw std::length_error("Kitten text pattern work limit exceeded");
    --*budget;
    const auto op = kRegexCode[state.pc++];
    bool ok = true;
    switch (op.op) {
      case 0: *result = state.captures; return true;
      case 1:
      case 2: {
        ok = state.pos < text.size();
        if (ok) {
          auto c = text[state.pos];
          bool equal = (op.c ? Fold(c) : c) ==
                       (op.c ? Fold(op.a) : static_cast<char32_t>(op.a));
          ok = equal != (op.op == 2);
        }
        if (ok) ++state.pos;
        break;
      }
      case 3: ok = state.pos < text.size() && text[state.pos] != U'\n';
              if (ok) ++state.pos; break;
      case 4: ok = state.pos < text.size() && ClassMatches(op, text[state.pos]);
              if (ok) ++state.pos; break;
      case 5: { auto alternate = state; alternate.pc = op.b;
                stack.push_back(alternate); state.pc = op.a; break; }
      case 6: state.pc = op.a; break;
      case 7: state.captures.spans.at(op.a) = state.pos; break;
      case 8: {
        Match ignored;
        bool matched = state.pos >= static_cast<size_t>(op.b) &&
            MatchAt(op.a, text, state.pos - op.b, &ignored, budget);
        ok = matched != static_cast<bool>(op.c);
        break;
      }
      case 9: {
        bool left = state.pos && KittenIsWord(text[state.pos - 1]);
        bool right = state.pos < text.size() && KittenIsWord(text[state.pos]);
        switch (op.a) {
          case 0: ok = state.pos == 0; break;
          case 1: ok = state.pos == text.size() ||
                      (state.pos + 1 == text.size() && text[state.pos] == U'\n'); break;
          case 2: ok = left != right; break;
          case 3: ok = left == right; break;
        }
        break;
      }
      default: throw std::logic_error("Invalid Kitten pattern opcode");
    }
    if (!ok) {
      if (stack.empty()) return false;
      state = std::move(stack.back()); stack.pop_back();
    }
  }
}
template <typename Replace>
inline Text Sub(int entry, const Text &text, Replace replace) {
  Text out;
  size_t copied = 0, budget = 10000000;
  for (size_t pos = 0; pos < text.size();) {
    Match match;
    if (MatchAt(entry, text, pos, &match, &budget)) {
      auto end = match.spans[1];
      if (end <= pos) throw std::logic_error("Empty Kitten pattern match");
      out += text.substr(copied, pos - copied);
      out += replace(match);
      copied = pos = end;
    } else ++pos;
  }
  out += text.substr(copied);
  return out;
}
} }
#endif
