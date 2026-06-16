// sherpa-onnx/csrc/config-test.cc

#include "sherpa-onnx/csrc/features.h"
#include "sherpa-onnx/csrc/online-transducer-model-config.h"

#include <string>

#include "gtest/gtest.h"

namespace sherpa_onnx {

TEST(Config, FeatureExtractorDefaults) {
  FeatureExtractorConfig config;

  EXPECT_EQ(config.sampling_rate, 16000);
  EXPECT_EQ(config.feature_dim, 80);
  EXPECT_FLOAT_EQ(config.low_freq, 20.0f);
  EXPECT_FLOAT_EQ(config.high_freq, -400.0f);
  EXPECT_FLOAT_EQ(config.dither, 0.0f);
  EXPECT_TRUE(config.normalize_samples);
  EXPECT_FALSE(config.snip_edges);
}

TEST(Config, FeatureExtractorConstructorOverrides) {
  FeatureExtractorConfig config;
  config.sampling_rate = 8000;
  config.feature_dim = 40;

  EXPECT_EQ(config.sampling_rate, 8000);
  EXPECT_EQ(config.feature_dim, 40);
}

TEST(Config, OnlineTransducerModelConstructor) {
  OnlineTransducerModelConfig config("encoder.onnx", "decoder.onnx",
                                     "joiner.onnx");

  EXPECT_EQ(config.encoder, "encoder.onnx");
  EXPECT_EQ(config.decoder, "decoder.onnx");
  EXPECT_EQ(config.joiner, "joiner.onnx");

  std::string rendered = config.ToString();
  EXPECT_NE(rendered.find("encoder.onnx"), std::string::npos);
  EXPECT_NE(rendered.find("decoder.onnx"), std::string::npos);
  EXPECT_NE(rendered.find("joiner.onnx"), std::string::npos);
}

}  // namespace sherpa_onnx
