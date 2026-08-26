# Wfloat Vendor Notes

This directory is a source import of upstream `ggml-org/llama.cpp`, not a git
submodule.

- Upstream: https://github.com/ggml-org/llama.cpp
- Imported commit: `eab8ee41f889ef7823af517e8098fb8a9b3cf601`
- Import date: 2026-08-25
- Initial Wfloat use: baseline GGUF text generation through `wfloat-core`

Keep Wfloat integration code outside this directory when practical. If we patch
vendored files directly, document the reason and make the patch easy to replay
when refreshing from upstream.
