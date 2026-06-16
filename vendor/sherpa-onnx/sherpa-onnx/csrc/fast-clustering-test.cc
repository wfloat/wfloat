// sherpa-onnx/csrc/fast-clustering-test.cc
//
// Copyright (c)  2024  Xiaomi Corporation

#include "sherpa-onnx/csrc/fast-clustering.h"

#include <vector>

#include "gtest/gtest.h"

namespace sherpa_onnx {

TEST(FastClustering, TestTwoClusters) {
  std::vector<float> features = {
      // point 0
      0.1,
      0.1,
      // point 2
      0.4,
      -0.5,
      // point 3
      0.6,
      -0.7,
      // point 1
      0.2,
      0.3,
  };

  FastClusteringConfig config;
  config.num_clusters = 2;

  FastClustering clustering(config);
  auto labels = clustering.Cluster(features.data(), 4, 2);

  std::vector<int32_t> expected = {0, 1, 1, 0};
  EXPECT_EQ(labels, expected);
}

TEST(FastClustering, TestClusteringWithThreshold) {
  std::vector<float> features = {
      // point 0
      0.1,
      0.1,
      // point 2
      0.4,
      -0.5,
      // point 3
      0.6,
      -0.7,
      // point 1
      0.2,
      0.3,
  };

  FastClusteringConfig config;
  config.threshold = 0.5;

  FastClustering clustering(config);
  auto labels = clustering.Cluster(features.data(), 4, 2);

  std::vector<int32_t> expected = {0, 1, 1, 0};
  EXPECT_EQ(labels, expected);
}

TEST(FastClustering, TestPythonSuiteFixtureByNumClusters) {
  std::vector<float> features = {
      0.2,  0.3,   // cluster 0
      0.3,  -0.4,  // cluster 1
      -0.1, -0.2,  // cluster 2
      -0.3, -0.5,  // cluster 2
      0.1,  -0.2,  // cluster 1
      0.1,  0.2,   // cluster 0
      -0.8, 1.9,   // cluster 3
      -0.4, -0.6,  // cluster 2
      -0.7, 0.9,   // cluster 3
  };

  FastClusteringConfig config;
  config.num_clusters = 4;
  ASSERT_TRUE(config.Validate());

  FastClustering clustering(config);
  auto labels = clustering.Cluster(features.data(), 9, 2);

  std::vector<int32_t> expected = {0, 1, 2, 2, 1, 0, 3, 2, 3};
  EXPECT_EQ(labels, expected);
}

TEST(FastClustering, TestPythonSuiteFixtureByThreshold) {
  std::vector<float> features = {
      0.2,  0.3,   // cluster 0
      0.3,  -0.4,  // cluster 1
      -0.1, -0.2,  // cluster 2
      -0.3, -0.5,  // cluster 2
      0.1,  -0.2,  // cluster 1
      0.1,  0.2,   // cluster 0
      -0.8, 1.9,   // cluster 3
      -0.4, -0.6,  // cluster 2
      -0.7, 0.9,   // cluster 3
  };

  FastClusteringConfig config;
  config.threshold = 0.2;
  ASSERT_TRUE(config.Validate());

  FastClustering clustering(config);
  auto labels = clustering.Cluster(features.data(), 9, 2);

  std::vector<int32_t> expected = {0, 1, 2, 2, 1, 0, 3, 2, 3};
  EXPECT_EQ(labels, expected);
}

}  // namespace sherpa_onnx
