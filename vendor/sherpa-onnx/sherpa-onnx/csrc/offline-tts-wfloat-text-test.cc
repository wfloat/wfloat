// sherpa-onnx/csrc/offline-tts-wfloat-text-test.cc

#include "sherpa-onnx/csrc/offline-tts.h"

#include <string>
#include <vector>

#include "gtest/gtest.h"

namespace sherpa_onnx {

TEST(OfflineTtsWfloatText, PrepareTextAddsEmotionMarkers) {
  WfloatPreparedText prepared =
      PrepareWfloatText("Hello world. What now?!", "joy", 0.0f);

  std::vector<std::string> expected_text = {"Hello world.", " What now?!"};
  std::vector<std::string> expected_clean = {
      "Hello world." "\xF0\x9F\x98\x84" "\xE2\x93\xAA",
      "What now?" "\xF0\x9F\x98\x84" "\xE2\x93\xAA",
  };
  std::vector<std::string> expected_phonemes = {
      "\xF0\x9F\x98\x84" "\xE2\x93\xAA",
      "\xF0\x9F\x98\x84" "\xE2\x93\xAA",
  };

  EXPECT_EQ(prepared.text, expected_text);
  EXPECT_EQ(prepared.text_clean, expected_clean);
  EXPECT_EQ(prepared.text_phonemes, expected_phonemes);
}

}  // namespace sherpa_onnx
