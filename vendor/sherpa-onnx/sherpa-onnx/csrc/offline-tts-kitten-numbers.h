// Adapted from KittenML/KittenTTS ab5592c, Apache-2.0.
// See WFLOAT_KITTEN_08.md and tests/kitten/KITTEN-LICENSE.txt.
#ifndef SHERPA_ONNX_CSRC_OFFLINE_TTS_KITTEN_NUMBERS_H_
#define SHERPA_ONNX_CSRC_OFFLINE_TTS_KITTEN_NUMBERS_H_
#include <cmath>
#include <iomanip>
#include <limits>
#include <locale>
#include <sstream>
#include <stdexcept>
#include <string>
#include <utility>
#include "sherpa-onnx/csrc/offline-tts-kitten-text-unicode.h"
namespace sherpa_onnx { namespace kitten_text {
inline Text AsText(const std::string &s) { return Text(s.begin(), s.end()); }
inline std::string NumericAscii(const Text &s) {
  std::string out;
  for (auto c : s) {
    int d = Decimal(c);
    if (d >= 0) out.push_back('0' + d);
    else if (c < 128) out.push_back(static_cast<char>(c));
    else throw std::invalid_argument("Invalid Kitten numeric character");
  }
  return out;
}
inline Text WithoutCommas(Text s) {
  s.erase(std::remove(s.begin(), s.end(), U','), s.end()); return s;
}
inline std::string Integer(const Text &s) {
  auto raw = NumericAscii(s);
  bool negative = !raw.empty() && raw[0] == '-';
  size_t start = !raw.empty() && (raw[0] == '-' || raw[0] == '+') ? 1 : 0;
  if (start == raw.size()) throw std::invalid_argument("Invalid Kitten integer");
  if (raw.size() - start > 4300) throw std::invalid_argument("Kitten integer digit limit exceeded");
  for (size_t i = start; i < raw.size(); ++i)
    if (raw[i] < '0' || raw[i] > '9') throw std::invalid_argument("Invalid Kitten integer");
  while (start < raw.size() && raw[start] == '0') ++start;
  if (start == raw.size()) return "0";
  return (negative ? "-" : "") + raw.substr(start);
}
inline const Text &Digit(int n) {
  static const Text words[] = {U"zero", U"one", U"two", U"three", U"four", U"five",
    U"six", U"seven", U"eight", U"nine", U"ten", U"eleven", U"twelve", U"thirteen",
    U"fourteen", U"fifteen", U"sixteen", U"seventeen", U"eighteen", U"nineteen"};
  return words[n];
}
inline Text ThreeDigits(int n) {
  static const Text tens[] = {U"", U"", U"twenty", U"thirty", U"forty", U"fifty",
                             U"sixty", U"seventy", U"eighty", U"ninety"};
  Text out;
  if (n >= 100) out = Digit(n / 100) + U" hundred";
  n %= 100;
  if (n) {
    if (!out.empty()) out += U' ';
    if (n < 20) out += Digit(n);
    else { out += tens[n / 10]; if (n % 10) out += U"-" + Digit(n % 10); }
  }
  return out;
}
inline Text Number(const Text &raw) {
  auto n = Integer(raw);
  if (n == "0") return U"zero";
  bool negative = n[0] == '-';
  if (negative) n.erase(0, 1);
  Text out;
  if (n.size() <= 4) {
    int value = std::stoi(n);
    if (value >= 100 && value <= 9999 && value % 100 == 0 &&
        value % 1000 != 0 && value / 100 < 20)
      out = Digit(value / 100) + U" hundred";
  }
  if (out.empty()) {
    static const Text scale[] = {U"", U"thousand", U"million", U"billion", U"trillion"};
    // Upstream intentionally only iterates these five scales. Do not overflow
    // an int64 or extend the upstream vocabulary for very large integers.
    for (size_t i = 0, end = n.size(); i < 5 && end; ++i) {
      size_t start = end > 3 ? end - 3 : 0;
      int part = std::stoi(n.substr(start, end - start)); end = start;
      if (!part) continue;
      Text words = ThreeDigits(part);
      if (i) words += U" " + scale[i];
      out = words + (out.empty() ? Text() : U" " + out);
    }
  }
  return (negative ? U"negative " : U"") + out;
}
inline Text Number(int n) { return Number(AsText(std::to_string(n))); }
inline Text FloatWords(Text raw) {
  bool negative = !raw.empty() && raw.front() == U'-';
  if (negative) raw.erase(0, 1);
  auto exponent_pos = raw.find_first_of(U"eE");
  if (exponent_pos != Text::npos) {
    // Intentional upstream bug fix: float repr switches to scientific notation
    // for valid small percentages/units. Do not pass "1e-05" to Integer, or
    // truncate the fraction to zero. Large exponents use scientific words so
    // they do not exceed the inherited number-word vocabulary (trillion).
    int exponent = std::stoi(Integer(raw.substr(exponent_pos + 1)));
    auto mantissa = raw.substr(0, exponent_pos);
    if (exponent >= 0) {
      return (negative ? U"negative " : U"") + FloatWords(mantissa) +
             U" times ten to the " + Number(exponent);
    }
    auto dot = mantissa.find(U'.');
    int point = static_cast<int>(dot == Text::npos ? mantissa.size() : dot) + exponent;
    mantissa.erase(std::remove(mantissa.begin(), mantissa.end(), U'.'), mantissa.end());
    raw = point <= 0 ? U"0." + Text(-point, U'0') + mantissa :
          mantissa.substr(0, point) + U"." + mantissa.substr(point);
  }
  auto dot = raw.find(U'.');
  Text out;
  if (dot == Text::npos) out = Number(raw);
  else {
    out = (dot ? Number(raw.substr(0, dot)) : U"zero") + U" point ";
    for (size_t i = dot + 1; i < raw.size(); ++i) {
      int d = Decimal(raw[i]);
      if (d < 0) throw std::invalid_argument("Invalid Kitten decimal");
      if (i > dot + 1) out += U' ';
      out += Digit(d);
    }
  }
  return (negative ? U"negative " : U"") + out;
}
inline double ParseFloat(const Text &text) {
  auto s = NumericAscii(text);
  double value = 0;
  // Floating from_chars is absent in supported Apple libc++ versions. The
  // classic locale stream is available on all consumers and does not mutate
  // the process locale.
  std::istringstream input(s);
  input.imbue(std::locale::classic());
  input >> value;
  if (input.fail()) {
    // libc++ can report ERANGE after returning a correctly rounded subnormal.
    if (input.eof() && std::fpclassify(value) == FP_SUBNORMAL) return value;
    // Python float underflows to signed zero. Accept only a zero result whose
    // plain-decimal integer part is zero; overflowing integers still fail.
    auto dot = s.find('.');
    bool fractional = dot != std::string::npos && value == 0;
    for (size_t i = !s.empty() && s[0] == '-' ? 1 : 0; i < dot && i < s.size(); ++i)
      fractional = fractional && s[i] == '0';
    if (fractional) return !s.empty() && s[0] == '-' ? -0.0 : 0.0;
    throw std::invalid_argument("Invalid or out-of-range Kitten float");
  }
  if (!input.eof() || !std::isfinite(value))
    throw std::invalid_argument("Invalid or out-of-range Kitten float");
  return value;
}
inline Text PythonFloatString(const Text &text) {
  double value = ParseFloat(text);
  // Floating to_chars requires iOS 16.3, while the engine supports iOS 13.
  // Round to increasing significant precision in the classic locale. The
  // first nearest decimal that round-trips is the shortest representation;
  // scientific formatting keeps this independent of exponent display rules.
  std::string scientific;
  for (int precision = 1; precision <= std::numeric_limits<double>::max_digits10; ++precision) {
    std::ostringstream output;
    output.imbue(std::locale::classic());
    output << std::scientific << std::setprecision(precision - 1) << value;
    auto candidate = output.str();
    try {
      auto recovered = ParseFloat(AsText(candidate));
      if (recovered == value && std::signbit(recovered) == std::signbit(value)) {
        scientific = std::move(candidate); break;
      }
    } catch (const std::invalid_argument &) {
      // A rounded candidate can overflow even when the original is finite.
    }
  }
  if (scientific.empty()) throw std::invalid_argument("Kitten float formatting failed");
  auto e = scientific.find('e');
  int exponent = std::stoi(scientific.substr(e + 1));
  if (exponent < -4 || exponent >= 16) return AsText(scientific);
  bool negative = std::signbit(value);
  auto digits = scientific.substr(negative ? 1 : 0, e - (negative ? 1 : 0));
  digits.erase(std::remove(digits.begin(), digits.end(), '.'), digits.end());
  int point = exponent + 1;
  std::string out;
  if (point <= 0) out = "0." + std::string(-point, '0') + digits;
  else if (point >= static_cast<int>(digits.size()))
    out = digits + std::string(point - digits.size(), '0') + ".0";
  else out = digits.substr(0, point) + "." + digits.substr(point);
  return AsText((negative ? "-" : "") + out);
}
inline Text FloatInteger(const Text &text) {
  // Used only for generic integers (no decimal point), matching int(float(raw)).
  auto value = ParseFloat(text);
  std::ostringstream out;
  out.imbue(std::locale::classic());
  out << std::fixed << std::setprecision(0) << std::trunc(value);
  return AsText(out.str());
}
inline Text NumericWords(const Text &raw, bool round_trip_float = false) {
  return raw.find(U'.') == Text::npos ? Number(raw) :
         FloatWords(round_trip_float ? PythonFloatString(raw) : raw);
}
inline Text Ordinal(const Text &raw) {
  Text word = Number(raw);
  size_t pos = word.rfind(U'-');
  if (pos == Text::npos) pos = word.rfind(U' ');
  Text prefix = pos == Text::npos ? Text() : word.substr(0, pos + 1);
  Text last = pos == Text::npos ? word : word.substr(pos + 1);
  static const std::pair<Text, Text> exceptions[] = {
    {U"one",U"first"},{U"two",U"second"},{U"three",U"third"},{U"four",U"fourth"},
    {U"five",U"fifth"},{U"six",U"sixth"},{U"seven",U"seventh"},{U"eight",U"eighth"},
    {U"nine",U"ninth"},{U"twelve",U"twelfth"}};
  for (const auto &e : exceptions) if (last == e.first) return prefix + e.second;
  if (!last.empty() && last.back() == U't') last += U'h';
  else if (!last.empty() && last.back() == U'e') { last.pop_back(); last += U"th"; }
  else last += U"th";
  return prefix + last;
}
inline Text SpellDigits(const Text &raw) {
  Text out;
  for (auto c : raw) {
    // The upstream phone/IP maps accept ASCII digits only, despite Unicode \d.
    if (c < U'0' || c > U'9') throw std::invalid_argument("Kitten phone/IP expects ASCII digits");
    if (!out.empty()) out += U' ';
    out += Digit(c - U'0');
  }
  return out;
}
inline Text Scale(const Text &s) {
  if (s == U"K") return U"thousand";
  if (s == U"M") return U"million";
  if (s == U"B") return U"billion";
  if (s == U"T") return U"trillion";
  throw std::invalid_argument("Invalid Kitten scale suffix");
}
} }
#endif
