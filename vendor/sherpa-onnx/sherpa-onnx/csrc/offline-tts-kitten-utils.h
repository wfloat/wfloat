// Wfloat Kitten 0.8 overlay; see WFLOAT_KITTEN_08.md for source/contract.
#ifndef SHERPA_ONNX_CSRC_OFFLINE_TTS_KITTEN_UTILS_H_
#define SHERPA_ONNX_CSRC_OFFLINE_TTS_KITTEN_UTILS_H_

#include <algorithm>
#include <cstdint>
#include <stdexcept>
#include <unordered_map>
#include <vector>

#include "sherpa-onnx/csrc/offline-tts-kitten-model-meta-data.h"
#include "sherpa-onnx/csrc/offline-tts-kitten-unicode.h"

namespace sherpa_onnx {

inline bool IsKitten08(const OfflineTtsKittenModelMetaData &meta) {
  return meta.version == 8;
}

inline int32_t Kitten08StyleRow(int64_t text_length, int32_t rows) {
  if (text_length < 0 || rows <= 0) {
    throw std::invalid_argument("Kitten 0.8 requires normalized chunk length");
  }
  return static_cast<int32_t>(std::min<int64_t>(text_length, rows - 1));
}

inline int64_t KittenAudioLength(int64_t length, int32_t version) {
  return version == 8 ? std::max<int64_t>(0, length - 5000) : length;
}

// Equivalent to ' '.join(re.findall(r'\w+|[^\w\s]', phonemes)), then
// TextCleaner. Tokenize BEFORE discarding unknown symbols: their boundaries
// still contribute spaces, exactly as in Python. Never append a period space.
inline std::vector<int64_t> Kitten08TokenIds(
    const std::vector<char32_t> &phonemes,
    const std::unordered_map<char32_t, int32_t> &token2id,
    const OfflineTtsKittenModelMetaData &meta, bool enforce_limit = true) {
  std::vector<int64_t> ids{meta.start_id};
  bool have_token = false;
  bool previous_word = false;
  bool whitespace = false;
  for (auto c : phonemes) {
    if (KittenIsSpace(c)) {
      whitespace = true;
      continue;
    }
    bool word = KittenIsWord(c);
    if (have_token && (whitespace || !previous_word || !word)) {
      ids.push_back(token2id.at(U' '));
    }
    auto it = token2id.find(c);
    if (it != token2id.end()) ids.push_back(it->second);
    have_token = true;
    previous_word = word;
    whitespace = false;
  }
  if (!have_token) return {};
  ids.push_back(meta.end_id);
  if (meta.add_pad_after_end) ids.push_back(meta.pad_id);
  // Splitting IDs here loses the corresponding text/style row. The caller
  // must bound text chunks before phonemization instead.
  if (enforce_limit && ids.size() > static_cast<size_t>(meta.max_token_len)) {
    throw std::length_error("Kitten 0.8 chunk exceeds model token limit");
  }
  return ids;
}
}  // namespace sherpa_onnx
#endif  // SHERPA_ONNX_CSRC_OFFLINE_TTS_KITTEN_UTILS_H_
