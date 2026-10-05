#include "LlmModelParams.h"
#include "ggml-backend.h"
#include <iostream>
#include <stdexcept>
int main() {
  llama_backend_init();
  const auto params = wfloat_next::nativeLlmModelParams();
  if (params.load_mode != LLAMA_LOAD_MODE_AUTO || params.n_gpu_layers != 0)
    throw std::runtime_error("Native CPU GGUF must retain AUTO loading, not WASM's resident-copy mode");
  auto* cpu = ggml_backend_dev_by_type(GGML_BACKEND_DEVICE_TYPE_CPU);
  if (!cpu || !llama_supports_mmap()) throw std::runtime_error("Native test requires CPU mmap support");
  ggml_backend_dev_props props{};
  ggml_backend_dev_get_props(cpu, &props);
  if (!props.caps.mmap_support || !props.caps.buffer_from_host_ptr)
    throw std::runtime_error("CPU cannot use file-backed tensor buffers");
  llama_backend_free();
  std::cout << "PASS native AUTO config and actual CPU mmap/host-buffer capabilities\n";
}
