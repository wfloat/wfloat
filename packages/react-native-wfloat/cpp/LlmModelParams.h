#pragma once
#include "llama.h"

namespace wfloat_next {
inline llama_model_params nativeLlmModelParams() {
  auto params = llama_model_default_params();
  params.n_gpu_layers = 0;
  // Unlike WASM, native CPU supports file-backed weights. AUTO retains llama's
  // capability fallback; NONE would allocate/read a resident copy of each shard.
  params.load_mode = LLAMA_LOAD_MODE_AUTO;
  return params;
}
}
