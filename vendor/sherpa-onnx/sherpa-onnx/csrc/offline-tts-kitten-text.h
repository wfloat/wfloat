// Adapted by Wfloat from KittenML/KittenTTS ab5592c28b6f376ea4c3963e84ce6d6688241eca
// kittenml/preprocess.py, Apache-2.0. See WFLOAT_KITTEN_08.md and
// tests/kitten/KITTEN-LICENSE.txt. Defaults of TextPreprocessor with
// remove_punctuation=False, followed by chunk_text. Not normalize_text().
#ifndef SHERPA_ONNX_CSRC_OFFLINE_TTS_KITTEN_TEXT_H_
#define SHERPA_ONNX_CSRC_OFFLINE_TTS_KITTEN_TEXT_H_
#include <map>
#include <set>
#include "sherpa-onnx/csrc/offline-tts-kitten-numbers.h"
#include "sherpa-onnx/csrc/offline-tts-kitten-regex.h"
namespace sherpa_onnx { namespace kitten_text {
inline Text Normalize(Text text) {
  text = Nfc(text);
  text = Sub(rx_html, text, [](const Match &) { return U" "; });
  text = Strip(Sub(rx_url, text, [](const Match &) { return U""; }));
  text = Strip(Sub(rx_email, text, [](const Match &) { return U""; }));
  const int contractions[] = {rx_contraction_0, rx_contraction_1, rx_contraction_2,
    rx_contraction_3, rx_contraction_4, rx_contraction_5, rx_contraction_6,
    rx_contraction_7, rx_contraction_8, rx_contraction_9, rx_contraction_10, rx_contraction_11};
  const Text replacement[] = {U"cannot", U"will not", U"shall not", U"is not", U"let us",
    U" not", U" are", U" have", U" will", U" would", U" am", U"it is"};
  for (size_t i = 0; i < 12; ++i) {
    text = Sub(contractions[i], text, [&](const Match &m) {
      return (i >= 5 && i <= 10 ? m.Group(text, 1) : Text()) + replacement[i];
    });
  }
  text = Sub(rx_ip, text, [&](const Match &m) {
    Text out;
    for (size_t i = 1; i <= 4; ++i) {
      if (i > 1) out += U" dot "; out += SpellDigits(m.Group(text, i));
    }
    return out;
  });
  text = Sub(rx_negative_decimal, text, [&](const Match &m) {
    return m.Group(text, 1) + U"0." + m.Group(text, 2);
  });
  text = Sub(rx_lead_dec, text, [&](const Match &m) { return U"0." + m.Group(text, 1); });
  text = Sub(rx_currency, text, [&](const Match &m) {
    static const std::map<Text, Text> names = {{U"$", U"dollar"}, {U"€", U"euro"},
      {U"£", U"pound"}, {U"¥", U"yen"}, {U"₹", U"rupee"}, {U"₩", U"won"}, {U"₿", U"bitcoin"}};
    Text raw = WithoutCommas(m.Group(text, 2));
    const Text &unit = names.at(m.Group(text, 1));
    Text scale = m.Group(text, 3);
    if (!scale.empty()) return NumericWords(raw) + U" " + Scale(scale) + U" " + unit + U"s";
    auto dot = raw.find(U'.');
    if (dot == Text::npos) return Number(raw) + U" " + unit + (Integer(raw) == "1" ? U"" : U"s");
    Text cents = raw.substr(dot + 1, 2);
    while (cents.size() < 2) cents += U'0';
    int amount = std::stoi(Integer(cents));
    Text out = Number(raw.substr(0, dot)) + U" " + unit + U"s";
    if (amount) out += U" and " + Number(amount) + (amount == 1 ? U" cent" : U" cents");
    return out;
  });
  text = Sub(rx_percent, text, [&](const Match &m) {
    return NumericWords(WithoutCommas(m.Group(text, 1)), true) + U" percent";
  });
  text = Sub(rx_sci, text, [&](const Match &m) {
    auto exponent = Integer(m.Group(text, 2));
    bool negative = exponent[0] == '-';
    if (negative) exponent.erase(0, 1);
    return NumericWords(m.Group(text, 1)) + U" times ten to the " +
           (negative ? U"negative " : U"") + Number(AsText(exponent));
  });
  text = Sub(rx_time, text, [&](const Match &m) {
    int minutes = std::stoi(Integer(m.Group(text, 2)));
    Text suffix = Lower(m.Group(text, 4));
    Text out = Number(m.Group(text, 1));
    if (minutes == 0) { if (suffix.empty()) out += U" hundred"; }
    else { out += minutes < 10 ? U" oh " : U" "; out += Number(minutes); }
    if (!suffix.empty()) out += U" " + suffix;
    return out;
  });
  text = Sub(rx_ordinal, text, [&](const Match &m) { return Ordinal(m.Group(text, 1)); });
  text = Sub(rx_unit, text, [&](const Match &m) {
    static const std::map<Text, Text> units = {
      {U"km",U"kilometers"},{U"kg",U"kilograms"},{U"mg",U"milligrams"},{U"ml",U"milliliters"},
      {U"gb",U"gigabytes"},{U"mb",U"megabytes"},{U"kb",U"kilobytes"},{U"tb",U"terabytes"},
      {U"hz",U"hertz"},{U"khz",U"kilohertz"},{U"mhz",U"megahertz"},{U"ghz",U"gigahertz"},
      {U"mph",U"miles per hour"},{U"kph",U"kilometers per hour"},{U"ms",U"milliseconds"},
      {U"ns",U"nanoseconds"},{U"µs",U"microseconds"},{U"°c",U"degrees Celsius"},
      {U"c°",U"degrees Celsius"},{U"°f",U"degrees Fahrenheit"},{U"f°",U"degrees Fahrenheit"}};
    auto unit = units.find(Lower(m.Group(text, 2)));
    return NumericWords(m.Group(text, 1), true) + U" " +
           (unit == units.end() ? m.Group(text, 2) : unit->second);
  });
  text = Sub(rx_scale, text, [&](const Match &m) {
    return NumericWords(m.Group(text, 1)) + U" " + Scale(m.Group(text, 2));
  });
  text = Sub(rx_fraction, text, [&](const Match &m) {
    auto numerator = Integer(m.Group(text, 1)), denominator = Integer(m.Group(text, 2));
    if (denominator == "0") return m.Group(text);
    Text denom;
    if (denominator == "2") denom = numerator == "1" ? U"half" : U"halves";
    else if (denominator == "4") denom = numerator == "1" ? U"quarter" : U"quarters";
    else { denom = Ordinal(AsText(denominator)); if (numerator != "1") denom += U's'; }
    return Number(AsText(numerator)) + U" " + denom;
  });
  text = Sub(rx_decade, text, [&](const Match &m) {
    static const Text words[] = {U"hundreds",U"tens",U"twenties",U"thirties",U"forties",
      U"fifties",U"sixties",U"seventies",U"eighties",U"nineties"};
    int base = std::stoi(Integer(m.Group(text, 1)));
    return (base < 10 ? Text() : Number(base / 10) + U" ") + words[base % 10];
  });
  for (auto pattern : {rx_phone_11, rx_phone_10, rx_phone_7}) {
    text = Sub(pattern, text, [&](const Match &m) {
      Text out;
      for (size_t i = 1; i < 8 && m.spans[2 * i] != Text::npos; ++i) {
        if (!out.empty()) out += U' '; out += SpellDigits(m.Group(text, i));
      }
      return out;
    });
  }
  text = Sub(rx_range, text, [&](const Match &m) {
    return Number(m.Group(text, 1)) + U" to " + Number(m.Group(text, 2));
  });
  text = Sub(rx_model_ver, text, [&](const Match &m) {
    return m.Group(text, 1) + U" " + m.Group(text, 2);
  });
  text = Sub(rx_number, text, [&](const Match &m) {
    auto raw = WithoutCommas(m.Group(text));
    try {
      return raw.find(U'.') == Text::npos ? Number(FloatInteger(raw)) : FloatWords(raw);
    } catch (const std::invalid_argument &) { return m.Group(text); }
  });
  text = Lower(text);
  return Strip(Sub(rx_spaces, text, [](const Match &) { return U" "; }));
}
inline Text EnsurePunctuation(Text text) {
  text = Strip(text);
  if (!text.empty() && Text(U".!?,;:").find(text.back()) == Text::npos) text += U',';
  return text;
}
inline bool SentenceBoundary(const Text &text, size_t i) {
  auto c = text[i];
  if (c != U'.' && c != U'!' && c != U'?') return false;
  if (c == U'.') {
    if (i && i + 1 < text.size() && InRanges(kDigit, text[i - 1]) && InRanges(kDigit, text[i + 1])) return false;
    size_t start = i;
    while (start && ((text[start - 1] >= U'A' && text[start - 1] <= U'Z') ||
                    (text[start - 1] >= U'a' && text[start - 1] <= U'z'))) --start;
    Text word = Lower(text.substr(start, i - start));
    static const std::set<Text> abbreviations = {U"dr",U"prof",U"mr",U"mrs",U"ms",
      U"fig",U"figs",U"pp",U"p",U"ch",U"sec",U"jan",U"feb",U"mar",U"apr",U"jun",
      U"jul",U"aug",U"sep",U"sept",U"oct",U"nov",U"dec",U"al"};
    if (abbreviations.count(word)) return false;
    if ((word == U"a" || word == U"p") && i + 1 < text.size() && Lower(text.substr(i + 1, 1)) == U"m") return false;
    if (word == U"m") {
      Text before = text.substr(0, i);
      Match match; size_t budget = 100000;
      bool ampm = false;
      for (size_t p = 0; p < before.size() && !ampm; ++p)
        ampm = MatchAt(rx_ampm, before, p, &match, &budget);
      if (ampm) {
        auto next = Strip(text.substr(i + 1));
        return next.empty() || InRanges(kUpper, next.front());
      }
    }
  }
  return i + 1 == text.size() || KittenIsSpace(text[i + 1]);
}
inline std::vector<Text> Chunk(const Text &text, size_t max_length = 400) {
  std::vector<Text> sentences, chunks;
  size_t start = 0;
  for (size_t i = 0; i < text.size(); ++i) {
    if (SentenceBoundary(text, i)) {
      sentences.push_back(text.substr(start, i + 1 - start)); start = i + 1;
    }
  }
  if (start < text.size()) sentences.push_back(text.substr(start));
  for (auto sentence : sentences) {
    sentence = Strip(sentence);
    if (sentence.empty()) continue;
    if (sentence.size() <= max_length) { chunks.push_back(EnsurePunctuation(sentence)); continue; }
    Text current;
    for (size_t pos = 0; pos < sentence.size();) {
      while (pos < sentence.size() && KittenIsSpace(sentence[pos])) ++pos;
      size_t end = pos;
      while (end < sentence.size() && !KittenIsSpace(sentence[end])) ++end;
      if (end == pos) break;
      Text word = sentence.substr(pos, end - pos); pos = end;
      if (current.size() + word.size() + 1 <= max_length) {
        if (!current.empty()) current += U' ';
        current += word;
      } else {
        if (!current.empty()) chunks.push_back(EnsurePunctuation(current));
        current = word;
      }
    }
    if (!current.empty()) chunks.push_back(EnsurePunctuation(current));
  }
  return chunks;
}
inline std::vector<Text> Prepare(const Text &raw) { return Chunk(Normalize(raw)); }
} }
#endif
