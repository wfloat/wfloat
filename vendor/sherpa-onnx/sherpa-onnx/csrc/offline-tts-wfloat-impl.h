// sherpa-onnx/csrc/offline-tts-wfloat-impl.h
//
// Copyright (c)  2023  Xiaomi Corporation
#ifndef SHERPA_ONNX_CSRC_OFFLINE_TTS_WFLOAT_IMPL_H_
#define SHERPA_ONNX_CSRC_OFFLINE_TTS_WFLOAT_IMPL_H_

#include <algorithm>
#include <array>
#include <fstream>
#include <memory>
#include <sstream>
#include <string>
#include <strstream>
#include <unordered_map>
#include <utility>
#include <vector>

#include "fst/extensions/far/far.h"
#include "kaldifst/csrc/kaldi-fst-io.h"
#include "kaldifst/csrc/text-normalizer.h"
#include "sherpa-onnx/csrc/character-lexicon.h"
#include "sherpa-onnx/csrc/file-utils.h"
#include "sherpa-onnx/csrc/lexicon.h"
#include "sherpa-onnx/csrc/macros.h"
#include "sherpa-onnx/csrc/melo-tts-lexicon.h"
#include "sherpa-onnx/csrc/offline-tts-character-frontend.h"
#include "sherpa-onnx/csrc/offline-tts-frontend.h"
#include "sherpa-onnx/csrc/offline-tts-impl.h"
#include "sherpa-onnx/csrc/offline-tts-wfloat-model.h"
#include "sherpa-onnx/csrc/piper-phonemize-lexicon.h"
#include "sherpa-onnx/csrc/symbol-table.h"
#include "sherpa-onnx/csrc/text-utils.h"

namespace sherpa_onnx {

class OfflineTtsWfloatImpl : public OfflineTtsImpl {
 public:
  explicit OfflineTtsWfloatImpl(const OfflineTtsConfig &config)
      : config_(config),
        model_(std::make_unique<OfflineTtsWfloatModel>(config.model)) {
    InitFrontend();
    InitEmotionTokenTable();

    if (!config.rule_fsts.empty()) {
      std::vector<std::string> files;
      SplitStringToVector(config.rule_fsts, ",", false, &files);
      tn_list_.reserve(files.size());
      for (const auto &f : files) {
        if (config.model.debug) {
#if __OHOS__
          SHERPA_ONNX_LOGE("rule fst: %{public}s", f.c_str());
#else
          SHERPA_ONNX_LOGE("rule fst: %s", f.c_str());
#endif
        }
        tn_list_.push_back(std::make_unique<kaldifst::TextNormalizer>(f));
      }
    }

    if (!config.rule_fars.empty()) {
      if (config.model.debug) {
        SHERPA_ONNX_LOGE("Loading FST archives");
      }
      std::vector<std::string> files;
      SplitStringToVector(config.rule_fars, ",", false, &files);

      tn_list_.reserve(files.size() + tn_list_.size());

      for (const auto &f : files) {
        if (config.model.debug) {
#if __OHOS__
          SHERPA_ONNX_LOGE("rule far: %{public}s", f.c_str());
#else
          SHERPA_ONNX_LOGE("rule far: %s", f.c_str());
#endif
        }
        std::unique_ptr<fst::FarReader<fst::StdArc>> reader(
            fst::FarReader<fst::StdArc>::Open(f));
        for (; !reader->Done(); reader->Next()) {
          std::unique_ptr<fst::StdConstFst> r(
              fst::CastOrConvertToConstFst(reader->GetFst()->Copy()));

          tn_list_.push_back(
              std::make_unique<kaldifst::TextNormalizer>(std::move(r)));
        }
      }

      if (config.model.debug) {
        SHERPA_ONNX_LOGE("FST archives loaded!");
      }
    }
  }

  template <typename Manager>
  OfflineTtsWfloatImpl(Manager *mgr, const OfflineTtsConfig &config)
      : config_(config),
        model_(std::make_unique<OfflineTtsWfloatModel>(mgr, config.model)) {
    InitFrontend(mgr);
    InitEmotionTokenTable(mgr);

    if (!config.rule_fsts.empty()) {
      std::vector<std::string> files;
      SplitStringToVector(config.rule_fsts, ",", false, &files);
      tn_list_.reserve(files.size());
      for (const auto &f : files) {
        if (config.model.debug) {
#if __OHOS__
          SHERPA_ONNX_LOGE("rule fst: %{public}s", f.c_str());
#else
          SHERPA_ONNX_LOGE("rule fst: %s", f.c_str());
#endif
        }
        auto buf = ReadFile(mgr, f);
        std::istrstream is(buf.data(), buf.size());
        tn_list_.push_back(std::make_unique<kaldifst::TextNormalizer>(is));
      }
    }

    if (!config.rule_fars.empty()) {
      std::vector<std::string> files;
      SplitStringToVector(config.rule_fars, ",", false, &files);
      tn_list_.reserve(files.size() + tn_list_.size());

      for (const auto &f : files) {
        if (config.model.debug) {
#if __OHOS__
          SHERPA_ONNX_LOGE("rule far: %{public}s", f.c_str());
#else
          SHERPA_ONNX_LOGE("rule far: %s", f.c_str());
#endif
        }

        auto buf = ReadFile(mgr, f);

        std::unique_ptr<std::istream> s(
            new std::istrstream(buf.data(), buf.size()));

        std::unique_ptr<fst::FarReader<fst::StdArc>> reader(
            fst::FarReader<fst::StdArc>::Open(std::move(s)));

        for (; !reader->Done(); reader->Next()) {
          std::unique_ptr<fst::StdConstFst> r(
              fst::CastOrConvertToConstFst(reader->GetFst()->Copy()));

          tn_list_.push_back(
              std::make_unique<kaldifst::TextNormalizer>(std::move(r)));
        }  // for (; !reader->Done(); reader->Next())
      }    // for (const auto &f : files)
    }      // if (!config.rule_fars.empty())
  }

  int32_t SampleRate() const override {
    return model_->GetMetaData().sample_rate;
  }

  int32_t NumSpeakers() const override {
    return model_->GetMetaData().num_speakers;
  }

  std::vector<std::string> ConvertTextToPhonemes(
      const std::vector<std::string> &text) const override {
    std::vector<std::string> ans;
    ans.reserve(text.size());

    const auto &meta_data = model_->GetMetaData();
    for (const auto &chunk : text) {
      auto token_ids = frontend_->ConvertTextToTokenIds(chunk, meta_data.voice);
      std::string chunk_phonemes;
      for (const auto &sentence_tokens : token_ids) {
        chunk_phonemes += ConvertTokenIdsToSymbols(sentence_tokens.tokens);
      }
      ans.push_back(std::move(chunk_phonemes));
    }

    return ans;
  }

  GeneratedAudio Generate(
      const std::string &_text, int64_t sid = 0, float speed = 1.0,
      GeneratedAudioCallback callback = nullptr) const override {
    const auto &meta_data = model_->GetMetaData();
    int32_t num_speakers = meta_data.num_speakers;

    if (num_speakers == 0 && sid != 0) {
#if __OHOS__
      SHERPA_ONNX_LOGE(
          "This is a single-speaker model and supports only sid 0. Given sid: "
          "%{public}d. sid is ignored",
          static_cast<int32_t>(sid));
#else
      SHERPA_ONNX_LOGE(
          "This is a single-speaker model and supports only sid 0. Given sid: "
          "%d. sid is ignored",
          static_cast<int32_t>(sid));
#endif
    }

    if (num_speakers != 0 && (sid >= num_speakers || sid < 0)) {
#if __OHOS__
      SHERPA_ONNX_LOGE(
          "This model contains only %{public}d speakers. sid should be in the "
          "range [%{public}d, %{public}d]. Given: %{public}d. Use sid=0",
          num_speakers, 0, num_speakers - 1, static_cast<int32_t>(sid));
#else
      SHERPA_ONNX_LOGE(
          "This model contains only %d speakers. sid should be in the range "
          "[%d, %d]. Given: %d. Use sid=0",
          num_speakers, 0, num_speakers - 1, static_cast<int32_t>(sid));
#endif
      sid = 0;
    }

    std::string text = _text;
    if (config_.model.debug) {
#if __OHOS__
      SHERPA_ONNX_LOGE("Raw text: %{public}s", text.c_str());
#else
      SHERPA_ONNX_LOGE("Raw text: %s", text.c_str());
#endif
    }

    auto parsed_text = ParseEmotionGroupings(text);
    const auto &sentence_emotion_slots = parsed_text.sentence_emotion_slots;

    if (config_.model.debug) {
      auto parsed_text_log = FormatParsedEmotionText(parsed_text);
#if __OHOS__
      SHERPA_ONNX_LOGE("ParsedEmotionText:\n%{public}s",
                       parsed_text_log.c_str());
#else
      SHERPA_ONNX_LOGE("ParsedEmotionText:\n%s", parsed_text_log.c_str());
#endif
    }
    text = std::move(parsed_text.text_without_emotion_groupings);

    if (config_.model.debug) {
#if __OHOS__
      SHERPA_ONNX_LOGE("After removing emotion groupings: %{public}s",
                       text.c_str());
#else
      SHERPA_ONNX_LOGE("After removing emotion groupings: %s", text.c_str());
#endif
    }

    if (!tn_list_.empty()) {
      for (const auto &tn : tn_list_) {
        text = tn->Normalize(text);
        if (config_.model.debug) {
#if __OHOS__
          SHERPA_ONNX_LOGE("After normalizing: %{public}s", text.c_str());
#else
          SHERPA_ONNX_LOGE("After normalizing: %s", text.c_str());
#endif
        }
      }
    }

    std::vector<TokenIDs> token_ids =
        frontend_->ConvertTextToTokenIds(text, meta_data.voice);

    if (token_ids.empty() ||
        (token_ids.size() == 1 && token_ids[0].tokens.empty())) {
      SHERPA_ONNX_LOGE("Failed to convert %s to token IDs", text.c_str());
      return {};
    }

    auto split_emotion_slots = SplitLongSentencesIfNeeded(
        &token_ids, sentence_emotion_slots, /*max_sentence_len=*/400);
    AppendEmotionSlotsToTokenIds(&token_ids, split_emotion_slots);

    std::vector<std::vector<int64_t>> x;
    std::vector<std::vector<int64_t>> tones;

    x.reserve(token_ids.size());

    for (auto &i : token_ids) {
      x.push_back(std::move(i.tokens));
    }

    if (!token_ids[0].tones.empty()) {
      tones.reserve(token_ids.size());
      for (auto &i : token_ids) {
        tones.push_back(std::move(i.tones));
      }
    }

    // TODO(fangjun): add blank inside the frontend, not here
    if (meta_data.add_blank && config_.model.wfloat.data_dir.empty() &&
        meta_data.frontend != "characters") {
      for (auto &k : x) {
        k = AddBlank(k);
      }

      for (auto &k : tones) {
        k = AddBlank(k);
      }
    }

    int32_t x_size = static_cast<int32_t>(x.size());

    if (config_.max_num_sentences <= 0 || x_size <= config_.max_num_sentences) {
      auto ans = Process(x, tones, sid, speed);
      if (callback) {
        callback(ans.samples.data(), ans.samples.size(), 1.0);
      }
      return ans;
    }

    // the input text is too long, we process sentences within it in batches
    // to avoid OOM. Batch size is config_.max_num_sentences
    std::vector<std::vector<int64_t>> batch_x;
    std::vector<std::vector<int64_t>> batch_tones;

    int32_t batch_size = config_.max_num_sentences;
    batch_x.reserve(config_.max_num_sentences);
    batch_tones.reserve(config_.max_num_sentences);
    int32_t num_batches = x_size / batch_size;

    if (config_.model.debug) {
#if __OHOS__
      SHERPA_ONNX_LOGE(
          "Text is too long. Split it into %{public}d batches. batch size: "
          "%{public}d. Number of sentences: %{public}d",
          num_batches, batch_size, x_size);
#else
      SHERPA_ONNX_LOGE(
          "Text is too long. Split it into %d batches. batch size: %d. Number "
          "of sentences: %d",
          num_batches, batch_size, x_size);
#endif
    }

    GeneratedAudio ans;

    int32_t should_continue = 1;

    int32_t k = 0;

    for (int32_t b = 0; b != num_batches && should_continue; ++b) {
      batch_x.clear();
      batch_tones.clear();
      for (int32_t i = 0; i != batch_size; ++i, ++k) {
        batch_x.push_back(std::move(x[k]));

        if (!tones.empty()) {
          batch_tones.push_back(std::move(tones[k]));
        }
      }

      auto audio = Process(batch_x, batch_tones, sid, speed);
      ans.sample_rate = audio.sample_rate;
      ans.samples.insert(ans.samples.end(), audio.samples.begin(),
                         audio.samples.end());
      if (callback) {
        should_continue = callback(audio.samples.data(), audio.samples.size(),
                                   (b + 1) * 1.0 / num_batches);
        // Caution(fangjun): audio is freed when the callback returns, so users
        // should copy the data if they want to access the data after
        // the callback returns to avoid segmentation fault.
      }
    }

    batch_x.clear();
    batch_tones.clear();
    while (k < static_cast<int32_t>(x.size()) && should_continue) {
      batch_x.push_back(std::move(x[k]));
      if (!tones.empty()) {
        batch_tones.push_back(std::move(tones[k]));
      }

      ++k;
    }

    if (!batch_x.empty()) {
      auto audio = Process(batch_x, batch_tones, sid, speed);
      ans.sample_rate = audio.sample_rate;
      ans.samples.insert(ans.samples.end(), audio.samples.begin(),
                         audio.samples.end());
      if (callback) {
        callback(audio.samples.data(), audio.samples.size(), 1.0);
        // Caution(fangjun): audio is freed when the callback returns, so users
        // should copy the data if they want to access the data after
        // the callback returns to avoid segmentation fault.
      }
    }

    return ans;
  }

 private:
  struct ParsedEmotionText {
    std::string text_without_emotion_groupings;
    std::vector<std::array<char32_t, 2>> sentence_emotion_slots;
  };

  static std::string SlotToReadableString(char32_t slot) {
    if (slot == U'\0') {
      return "unset";
    }

    return Utf32ToUtf8(std::u32string(1, slot));
  }

  static std::string FormatParsedEmotionText(const ParsedEmotionText &parsed) {
    std::ostringstream os;
    os << "text_without_emotion_groupings: "
       << parsed.text_without_emotion_groupings << '\n';
    os << "sentence_emotion_slots (count="
       << parsed.sentence_emotion_slots.size() << ")";

    for (size_t i = 0; i < parsed.sentence_emotion_slots.size(); ++i) {
      const auto &slots = parsed.sentence_emotion_slots[i];
      os << '\n'
         << '[' << i << "] "
         << "emotion=" << SlotToReadableString(slots[0]) << ", "
         << "intensity=" << SlotToReadableString(slots[1]);
    }

    return os.str();
  }

  static bool IsSentenceTerminator(char32_t c) {
    return c == U'.' || c == U'?' || c == U'!';
  }

  static bool IsEmotionCodepoint(char32_t c) {
    switch (c) {
      case U'😐':
      case U'😄':
      case U'😢':
      case U'😡':
      case U'😱':
      case U'😲':
      case U'🙄':
      case U'🤔':
        return true;
      default:
        return false;
    }
  }

  static bool IsCircledDigitCodepoint(char32_t c) {
    switch (c) {
      case U'⓪':
      case U'①':
      case U'②':
      case U'③':
      case U'④':
      case U'⑤':
      case U'⑥':
      case U'⑦':
      case U'⑧':
      case U'⑨':
        return true;
      default:
        return false;
    }
  }

  static bool HasEmotionGroupingAt(const std::u32string &text, size_t i) {
    if (i + 2 >= text.size()) {
      return false;
    }

    return IsEmotionCodepoint(text[i + 1]) &&
           IsCircledDigitCodepoint(text[i + 2]);
  }

  static bool HasAllEmotionSlots(const std::array<char32_t, 2> &slots) {
    return std::all_of(slots.begin(), slots.end(),
                       [](char32_t c) { return c != U'\0'; });
  }

  static bool IsTerminalPunctuationSymbol(const std::string &s) {
    return s == "." || s == "!" || s == "?" || s == "。" || s == "！" ||
           s == "？" || s == ";" || s == "；" || s == ":" || s == "：";
  }

  int64_t GetTokenId(const std::string &sym) const {
    auto it = emotion_token2id_.find(sym);
    if (it == emotion_token2id_.end()) {
      return -1;
    }

    return it->second;
  }

  std::string GetTokenSymbol(int64_t id) const {
    auto it = emotion_id2token_.find(static_cast<int32_t>(id));
    if (it == emotion_id2token_.end()) {
      return "";
    }

    return it->second;
  }

  std::string ConvertTokenIdsToSymbols(const std::vector<int64_t> &token_ids) const {
    std::string ans;
    for (auto id : token_ids) {
      std::string sym = GetTokenSymbol(id);
      if (sym.empty() || sym == "^" || sym == "$") {
        continue;
      }
      ans += sym;
    }

    return ans;
  }

  int64_t GetDefaultTerminalPunctuationId() const {
    static const std::array<const char *, 10> kCandidates = {
        ".", "。", "!", "！", "?", "？", ";", "；", ":", "："};

    for (const auto *s : kCandidates) {
      auto id = GetTokenId(s);
      if (id >= 0) {
        return id;
      }
    }

    return -1;
  }

  int32_t FindSplitPointBySpace(const std::vector<int64_t> &tokens,
                                int32_t begin, int32_t hard_end,
                                int64_t space_id) const {
    if (space_id < 0) {
      return -1;
    }

    for (int32_t i = hard_end - 1; i > begin; --i) {
      if (tokens[i] == space_id) {
        return i;
      }
    }

    return -1;
  }

  std::vector<std::array<char32_t, 2>> SplitLongSentencesIfNeeded(
      std::vector<TokenIDs> *token_ids,
      const std::vector<std::array<char32_t, 2>> &sentence_emotion_slots,
      int32_t max_sentence_len) const {
    std::vector<std::array<char32_t, 2>> aligned_slots(token_ids->size(),
                                                       {U'\0', U'\0'});
    const size_t n = std::min(aligned_slots.size(), sentence_emotion_slots.size());
    for (size_t i = 0; i < n; ++i) {
      aligned_slots[i] = sentence_emotion_slots[i];
    }

    std::vector<TokenIDs> split_ids;
    split_ids.reserve(token_ids->size());

    std::vector<std::array<char32_t, 2>> split_slots;
    split_slots.reserve(token_ids->size());

    const int64_t bos_id = GetTokenId("^");
    const int64_t eos_id = GetTokenId("$");
    const int64_t space_id = GetTokenId(" ");

    for (size_t i = 0; i < token_ids->size(); ++i) {
      auto &t = (*token_ids)[i];
      const auto &slots = aligned_slots[i];

      int32_t emotion_extra = HasAllEmotionSlots(slots) ? 2 : 0;
      if (static_cast<int32_t>(t.tokens.size()) + emotion_extra <=
          max_sentence_len) {
        split_ids.push_back(std::move(t));
        split_slots.push_back(slots);
        continue;
      }

      int32_t core_begin = 0;
      int32_t core_end = static_cast<int32_t>(t.tokens.size());

      std::vector<int64_t> prefix_tokens;
      std::vector<int64_t> suffix_tokens;
      std::vector<int64_t> prefix_tones;
      std::vector<int64_t> suffix_tones;

      if (bos_id >= 0 && core_begin < core_end && t.tokens[core_begin] == bos_id) {
        prefix_tokens.push_back(t.tokens[core_begin]);
        if (!t.tones.empty() && static_cast<int32_t>(t.tones.size()) > core_begin) {
          prefix_tones.push_back(t.tones[core_begin]);
        }
        ++core_begin;
      }

      if (eos_id >= 0 && core_begin < core_end && t.tokens[core_end - 1] == eos_id) {
        suffix_tokens.push_back(t.tokens[core_end - 1]);
        if (!t.tones.empty() && static_cast<int32_t>(t.tones.size()) >= core_end) {
          suffix_tones.push_back(t.tones[core_end - 1]);
        }
        --core_end;
      }

      int64_t terminal_punct_id = -1;
      int32_t terminal_punct_tone = 0;

      int32_t punct_idx = core_end - 1;
      while (punct_idx >= core_begin && space_id >= 0 &&
             t.tokens[punct_idx] == space_id) {
        --punct_idx;
      }

      if (punct_idx >= core_begin) {
        auto sym = GetTokenSymbol(t.tokens[punct_idx]);
        if (IsTerminalPunctuationSymbol(sym)) {
          terminal_punct_id = t.tokens[punct_idx];
          if (!t.tones.empty() && static_cast<int32_t>(t.tones.size()) > punct_idx) {
            terminal_punct_tone = static_cast<int32_t>(t.tones[punct_idx]);
          }
          core_end = punct_idx;
          while (core_end > core_begin && space_id >= 0 &&
                 t.tokens[core_end - 1] == space_id) {
            --core_end;
          }
        }
      }

      if (terminal_punct_id < 0) {
        terminal_punct_id = GetDefaultTerminalPunctuationId();
      }

      int32_t punctuation_extra = terminal_punct_id >= 0 ? 1 : 0;
      int32_t fixed_extra = static_cast<int32_t>(prefix_tokens.size() +
                                                 suffix_tokens.size()) +
                            punctuation_extra + emotion_extra;
      int32_t chunk_budget = max_sentence_len - fixed_extra;
      if (chunk_budget <= 0) {
        chunk_budget = 1;
      }

      int32_t cur = core_begin;
      while (cur < core_end) {
        int32_t hard_end = std::min(core_end, cur + chunk_budget);
        int32_t split_point = hard_end;
        if (hard_end < core_end) {
          int32_t p = FindSplitPointBySpace(t.tokens, cur, hard_end, space_id);
          if (p > cur) {
            split_point = p;
          }
        }

        while (split_point > cur && space_id >= 0 &&
               t.tokens[split_point - 1] == space_id) {
          --split_point;
        }
        if (split_point <= cur) {
          split_point = std::min(core_end, cur + chunk_budget);
        }

        TokenIDs piece;
        piece.tokens.reserve(max_sentence_len);
        if (!t.tones.empty()) {
          piece.tones.reserve(max_sentence_len);
        }

        piece.tokens.insert(piece.tokens.end(), prefix_tokens.begin(),
                            prefix_tokens.end());
        if (!t.tones.empty()) {
          piece.tones.insert(piece.tones.end(), prefix_tones.begin(),
                             prefix_tones.end());
        }

        piece.tokens.insert(piece.tokens.end(), t.tokens.begin() + cur,
                            t.tokens.begin() + split_point);
        if (!t.tones.empty()) {
          piece.tones.insert(piece.tones.end(), t.tones.begin() + cur,
                             t.tones.begin() + split_point);
        }

        if (terminal_punct_id >= 0) {
          piece.tokens.push_back(terminal_punct_id);
          if (!t.tones.empty()) {
            piece.tones.push_back(terminal_punct_tone);
          }
        }

        piece.tokens.insert(piece.tokens.end(), suffix_tokens.begin(),
                            suffix_tokens.end());
        if (!t.tones.empty()) {
          piece.tones.insert(piece.tones.end(), suffix_tones.begin(),
                             suffix_tones.end());
        }

        split_ids.push_back(std::move(piece));
        split_slots.push_back(slots);

        cur = split_point;
        while (cur < core_end && space_id >= 0 && t.tokens[cur] == space_id) {
          ++cur;
        }
      }
    }

    *token_ids = std::move(split_ids);
    return split_slots;
  }

  std::vector<int64_t> ConvertEmotionSlotsToTokenIds(
      const std::array<char32_t, 2> &slots) const {
    std::vector<int64_t> ids;
    ids.reserve(slots.size());

    for (char32_t c : slots) {
      std::string symbol = Utf32ToUtf8(std::u32string(1, c));
      auto it = emotion_token2id_.find(symbol);
      if (it == emotion_token2id_.end()) {
        if (config_.model.debug) {
#if __OHOS__
          SHERPA_ONNX_LOGE("Failed to find token ID for emotion symbol: "
                           "%{public}s",
                           symbol.c_str());
#else
          SHERPA_ONNX_LOGE("Failed to find token ID for emotion symbol: %s",
                           symbol.c_str());
#endif
        }
        return {};
      }
      ids.push_back(it->second);
    }

    return ids;
  }

  void AppendEmotionSlotsToTokenIds(
      std::vector<TokenIDs> *token_ids,
      const std::vector<std::array<char32_t, 2>> &sentence_emotion_slots) const {
    if (!token_ids || token_ids->empty() || sentence_emotion_slots.empty() ||
        emotion_token2id_.empty()) {
      return;
    }

    const size_t n = std::min(token_ids->size(), sentence_emotion_slots.size());
    if (config_.model.debug && token_ids->size() != sentence_emotion_slots.size()) {
#if __OHOS__
      SHERPA_ONNX_LOGE("Sentence count mismatch when appending emotion symbols. "
                       "token_ids: %{public}d, groupings: %{public}d",
                       static_cast<int32_t>(token_ids->size()),
                       static_cast<int32_t>(sentence_emotion_slots.size()));
#else
      SHERPA_ONNX_LOGE("Sentence count mismatch when appending emotion symbols. "
                       "token_ids: %d, groupings: %d",
                       static_cast<int32_t>(token_ids->size()),
                       static_cast<int32_t>(sentence_emotion_slots.size()));
#endif
    }

    for (size_t i = 0; i < n; ++i) {
      const auto &slots = sentence_emotion_slots[i];
      if (!HasAllEmotionSlots(slots)) {
        continue;
      }

      auto slot_token_ids = ConvertEmotionSlotsToTokenIds(slots);
      if (slot_token_ids.size() != slots.size()) {
        continue;
      }

      auto &sentence_tokens = (*token_ids)[i].tokens;
      size_t insert_index = sentence_tokens.size();
      if (!sentence_tokens.empty() && sentence_tokens.back() == 0) {
        insert_index = sentence_tokens.size() - 1;
      }

      sentence_tokens.insert(sentence_tokens.begin() + insert_index,
                             slot_token_ids.begin(), slot_token_ids.end());

      auto &sentence_tones = (*token_ids)[i].tones;
      if (!sentence_tones.empty()) {
        size_t tone_insert_index = std::min(insert_index, sentence_tones.size());
        sentence_tones.insert(sentence_tones.begin() + tone_insert_index,
                              slot_token_ids.size(), 0);
      }
    }
  }

  static ParsedEmotionText ParseEmotionGroupings(const std::string &text) {
    ParsedEmotionText ans;

    std::u32string u32 = Utf8ToUtf32(text);
    std::u32string stripped;
    stripped.reserve(u32.size());

    for (size_t i = 0; i < u32.size(); ++i) {
      char32_t c = u32[i];
      stripped.push_back(c);

      if (!IsSentenceTerminator(c)) {
        continue;
      }

      std::array<char32_t, 2> slots = {U'\0', U'\0'};
      if (HasEmotionGroupingAt(u32, i)) {
        slots[0] = u32[i + 1];
        slots[1] = u32[i + 2];

        i += 2;  // skip 2-symbol emotion grouping
        if (i + 1 < u32.size() && u32[i + 1] == U' ') {
          // Keep the sentence separator space if present.
          stripped.push_back(U' ');
          ++i;
        }
      }

      ans.sentence_emotion_slots.push_back(slots);
    }

    ans.text_without_emotion_groupings = Utf32ToUtf8(stripped);
    return ans;
  }

  void InitEmotionTokenTable() {
    std::ifstream is(config_.model.wfloat.tokens);
    if (!is.is_open()) {
      SHERPA_ONNX_LOGE("Failed to open tokens file: %s",
                       config_.model.wfloat.tokens.c_str());
      return;
    }

    InitEmotionTokenTable(is);
  }

  template <typename Manager>
  void InitEmotionTokenTable(Manager *mgr) {
    auto buf = ReadFile(mgr, config_.model.wfloat.tokens);
    std::istrstream is(buf.data(), buf.size());
    InitEmotionTokenTable(is);
  }

  void InitEmotionTokenTable(std::istream &is) {
    emotion_id2token_.clear();
    emotion_token2id_ = ReadTokens(is, &emotion_id2token_);
  }

  template <typename Manager>
  void InitFrontend(Manager *mgr) {
    const auto &meta_data = model_->GetMetaData();

    if (meta_data.frontend == "characters") {
      frontend_ = std::make_unique<OfflineTtsCharacterFrontend>(
          mgr, config_.model.wfloat.tokens, meta_data);
    } else if (meta_data.jieba && meta_data.is_melo_tts) {
      frontend_ = std::make_unique<MeloTtsLexicon>(
          mgr, config_.model.wfloat.lexicon, config_.model.wfloat.tokens,
          model_->GetMetaData(), config_.model.debug);
    } else if (meta_data.jieba) {
      frontend_ = std::make_unique<CharacterLexicon>(
          mgr, config_.model.wfloat.lexicon, config_.model.wfloat.tokens,
          config_.model.debug);
    } else if (meta_data.is_melo_tts && meta_data.language == "English") {
      frontend_ = std::make_unique<MeloTtsLexicon>(
          mgr, config_.model.wfloat.lexicon, config_.model.wfloat.tokens,
          model_->GetMetaData(), config_.model.debug);
    } else if ((meta_data.is_piper || meta_data.is_coqui ||
                meta_data.is_icefall) &&
               !config_.model.wfloat.data_dir.empty()) {
      frontend_ = std::make_unique<PiperPhonemizeLexicon>(
          mgr, config_.model.wfloat.tokens, config_.model.wfloat.data_dir,
          meta_data);
    } else {
      if (config_.model.wfloat.lexicon.empty()) {
        SHERPA_ONNX_LOGE(
            "Not a model using characters as modeling unit. Please provide "
            "--wfloat-lexicon if you leave --wfloat-data-dir empty");
        SHERPA_ONNX_EXIT(-1);
      }

      frontend_ = std::make_unique<Lexicon>(
          mgr, config_.model.wfloat.lexicon, config_.model.wfloat.tokens,
          meta_data.punctuations, meta_data.language, config_.model.debug);
    }
  }

  void InitFrontend() {
    const auto &meta_data = model_->GetMetaData();

    if (meta_data.frontend == "characters") {
      frontend_ = std::make_unique<OfflineTtsCharacterFrontend>(
          config_.model.wfloat.tokens, meta_data);
    } else if (meta_data.jieba && meta_data.is_melo_tts) {
      frontend_ = std::make_unique<MeloTtsLexicon>(
          config_.model.wfloat.lexicon, config_.model.wfloat.tokens,
          model_->GetMetaData(), config_.model.debug);
    } else if (meta_data.is_melo_tts && meta_data.language == "English") {
      frontend_ = std::make_unique<MeloTtsLexicon>(
          config_.model.wfloat.lexicon, config_.model.wfloat.tokens,
          model_->GetMetaData(), config_.model.debug);
    } else if (meta_data.jieba) {
      frontend_ = std::make_unique<CharacterLexicon>(config_.model.wfloat.lexicon,
                                                     config_.model.wfloat.tokens,
                                                     config_.model.debug);
    } else if ((meta_data.is_piper || meta_data.is_coqui ||
                meta_data.is_icefall) &&
               !config_.model.wfloat.data_dir.empty()) {
      frontend_ = std::make_unique<PiperPhonemizeLexicon>(
          config_.model.wfloat.tokens, config_.model.wfloat.data_dir,
          model_->GetMetaData());
    } else {
      if (config_.model.wfloat.lexicon.empty()) {
        SHERPA_ONNX_LOGE(
            "Not a model using characters as modeling unit. Please provide "
            "--wfloat-lexicon if you leave --wfloat-data-dir empty");
        SHERPA_ONNX_EXIT(-1);
      }
      frontend_ = std::make_unique<Lexicon>(
          config_.model.wfloat.lexicon, config_.model.wfloat.tokens,
          meta_data.punctuations, meta_data.language, config_.model.debug);
    }
  }

  GeneratedAudio Process(const std::vector<std::vector<int64_t>> &tokens,
                         const std::vector<std::vector<int64_t>> &tones,
                         int32_t sid, float speed) const {
    int32_t num_tokens = 0;
    for (const auto &k : tokens) {
      num_tokens += k.size();
    }

    std::vector<int64_t> x;
    x.reserve(num_tokens);
    for (const auto &k : tokens) {
      x.insert(x.end(), k.begin(), k.end());
    }

    std::vector<int64_t> tone_list;
    if (!tones.empty()) {
      tone_list.reserve(num_tokens);
      for (const auto &k : tones) {
        tone_list.insert(tone_list.end(), k.begin(), k.end());
      }
    }

    auto memory_info =
        Ort::MemoryInfo::CreateCpu(OrtDeviceAllocator, OrtMemTypeDefault);

    std::array<int64_t, 2> x_shape = {1, static_cast<int32_t>(x.size())};
    Ort::Value x_tensor = Ort::Value::CreateTensor(
        memory_info, x.data(), x.size(), x_shape.data(), x_shape.size());

    Ort::Value tones_tensor{nullptr};
    if (!tones.empty()) {
      tones_tensor = Ort::Value::CreateTensor(memory_info, tone_list.data(),
                                              tone_list.size(), x_shape.data(),
                                              x_shape.size());
    }

    Ort::Value audio{nullptr};
    if (tones.empty()) {
      audio = model_->Run(std::move(x_tensor), sid, speed);
    } else {
      audio =
          model_->Run(std::move(x_tensor), std::move(tones_tensor), sid, speed);
    }

    std::vector<int64_t> audio_shape =
        audio.GetTensorTypeAndShapeInfo().GetShape();

    int64_t total = 1;
    // The output shape may be (1, 1, total) or (1, total) or (total,)
    for (auto i : audio_shape) {
      total *= i;
    }

    const float *p = audio.GetTensorData<float>();

    GeneratedAudio ans;
    ans.sample_rate = model_->GetMetaData().sample_rate;
    ans.samples = std::vector<float>(p, p + total);

    float silence_scale = config_.silence_scale;
    if (silence_scale != 1) {
      ans = ans.ScaleSilence(silence_scale);
    }

    return ans;
  }

 private:
  OfflineTtsConfig config_;
  std::unique_ptr<OfflineTtsWfloatModel> model_;
  std::vector<std::unique_ptr<kaldifst::TextNormalizer>> tn_list_;
  std::unique_ptr<OfflineTtsFrontend> frontend_;
  std::unordered_map<std::string, int32_t> emotion_token2id_;
  std::unordered_map<int32_t, std::string> emotion_id2token_;
};

}  // namespace sherpa_onnx
#endif  // SHERPA_ONNX_CSRC_OFFLINE_TTS_WFLOAT_IMPL_H_
