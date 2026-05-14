# wfloat-core src

This directory will hold the shared native implementation for `wfloat-core`.

The first intended implementation target is the draft TTS ABI in:

- `../include/wfloat-core/wfloat_tts.h`

Planned first pass:

- wrap `sherpa-onnx` offline TTS models behind `wfloat_tts_model_t`
- normalize one-shot synthesis results
- normalize dialogue synthesis results
- normalize progress/cancel callback behavior
- keep playback and download transport out of this layer
