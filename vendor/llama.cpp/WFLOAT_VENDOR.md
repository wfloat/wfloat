# Wfloat Vendor Notes

This directory is a source import of upstream `ggml-org/llama.cpp`, not a git
submodule.

- Upstream: https://github.com/ggml-org/llama.cpp
- Imported commit: `bb28c1fe246b72276ee1d00ce89306be7b865766`
- Import date: 2026-05-21
- Initial Wfloat use: baseline GGUF text generation through `wfloat-core`

Keep Wfloat integration code outside this directory when practical. If we patch
vendored files directly, document the reason and make the patch easy to replay
when refreshing from upstream.
