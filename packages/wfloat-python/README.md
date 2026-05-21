# wfloat

`wfloat` is the Python package for `wfloat-tts`, Wfloat's on-device English
text-to-speech model.

It runs speech locally in Python instead of calling a hosted inference API.
The model supports 20 voices with emotion and intensity control.

If you're building for the browser, use
[`@wfloat/wfloat-web`](https://github.com/wfloat/wfloat-web). If you're
building for React Native, use
[`@wfloat/react-native-wfloat`](https://github.com/wfloat/react-native-wfloat).

Browser demo to hear how it sounds: https://wfloat.com/demo

## Install

```bash
pip install wfloat
```

## Usage

```python
import wfloat

tts = wfloat.load_tts_model("wfloat/wfloat-tts")

result = tts.synthesize(
    text="No, no, that's not possible.",
    voice="mad_scientist_woman",
    emotion="surprise",
    intensity=0.7,
)

print(result.model_id)
print(result.timeline.chunks[0].text)
```

For multi-speaker dialogue:

```python
import wfloat

tts = wfloat.load_tts_model("wfloat/wfloat-tts")

result = tts.synthesize_dialogue(
    segments=[
        {
            "voice": "wise_elder_man",
            "text": "Rain taps against the tavern shutters as you step inside.",
            "emotion": "neutral",
            "intensity": 0.5,
        },
        {
            "voice": "strong_hero_man",
            "text": "You're late. Two bandits stole the king's map over three hours ago.",
            "emotion": "fear",
            "intensity": 0.6,
        },
        {
            "voice": "strong_hero_man",
            "text": "They fled north, up into the woods.",
            "emotion": "neutral",
            "intensity": 0.5,
        },
    ],
    silence_between_segments_sec=0.35,
)

result.audio.save("dialogue.wav")
```

The older `load(...)`, `generate(...)`, and `generate_dialogue(...)` names are
still available as compatibility aliases.

## Early STT Path In The Monorepo

The monorepo now also has an early offline STT path through `wfloat-core`.
The shared Python entrypoint is `load_stt_model(...)`, with
`load_whisper_tiny_en(...)` as a convenience wrapper:

```python
import wfloat

stt = wfloat.load_stt_model(
    "openai/whisper-tiny-en",
)

result = stt.transcribe(audio="/path/to/audio.wav")
print(result.text)
```

If you omit explicit asset URLs/paths, `load_stt_model(...)` is intended to use
the Wfloat-controlled asset manifest flow, just like the TTS loader path.

For local development you can still override assets explicitly when needed:

```python
stt = wfloat.load_stt_model(
    "UsefulSensors/moonshine-tiny",
    family="moonshine",
    preprocessor="https://example.com/preprocess.onnx",
    encoder="https://example.com/encode.onnx",
    uncached_decoder="https://example.com/uncached_decode.onnx",
    cached_decoder="https://example.com/cached_decode.onnx",
    tokens="https://example.com/tokens.txt",
)
```

That STT path is still an early monorepo development surface, not a polished
public distribution story yet.

Streaming-capable STT families also expose a separate session path instead of
overloading `transcribe(...)`:

```python
stt = wfloat.load_stt_model("k2-fsa/streaming-zipformer-en")
session = stt.create_session()

session.push(audio_chunk, sample_rate=16000)
partial = session.get_result()
final_result = session.finish()
session.close()
```

There is also a convenience loader for explicit local/URL overrides:

```python
stt = wfloat.load_stt_model(
    "streaming-model-id",
    family="zipformer-transducer",
    encoder="https://example.com/encoder-epoch-99-avg-1.int8.onnx",
    decoder="https://example.com/decoder-epoch-99-avg-1.onnx",
    joiner="https://example.com/joiner-epoch-99-avg-1.onnx",
    tokens="https://example.com/tokens.txt",
)
```

## Early VAD Path

Python also exposes the same one-shot VAD model shape as the web and React
Native packages. It is intentionally file/buffer based for now; there is no
Python live microphone/session helper.

```python
vad = wfloat.load_vad_model(
    "silero-vad",
    threshold=0.5,
    min_silence_duration_sec=0.5,
    min_speech_duration_sec=0.25,
    max_speech_duration_sec=20.0,
)

result = vad.detect(audio="/path/to/mono-16khz.wav")

for segment in result.segments:
    print(segment.start_sec, segment.duration_sec)
```

For local development you can override the VAD model asset explicitly:

```python
vad = wfloat.load_vad_model(
    "silero-vad",
    family="silero-vad",
    model="https://example.com/silero_vad.onnx",
)
```

VAD currently expects mono 16 kHz audio.

You can also generate a WAV from the command line:

```bash
wfloat generate \
  --text "Hello world!" \
  --out out.wav \
  --voice-id mad_scientist_woman \
  --emotion surprise \
  --intensity 0.7 \
  --silence-padding-sec 0
```

For the full CLI help:

```bash
wfloat generate --help
```

The first load downloads the model assets. After that, the package uses the
cached local copy.

## Native Backend During Monorepo Development

Inside this monorepo, the Python package now prefers a built `wfloat-core`
shared library when one is available. You can point it at an explicit build
artifact with:

```bash
export WFLOAT_CORE_LIBRARY=/abs/path/to/libwfloat-core.so
```

If no shared library is available, the package falls back to the direct
`sherpa_onnx` Python binding path.

## Speaker IDs

Use `voice_id` string names or numeric `sid` values:

| Speaker | SID |
| --- | ---: |
| `skilled_hero_man` | 0 |
| `skilled_hero_woman` | 1 |
| `fun_hero_man` | 2 |
| `fun_hero_woman` | 3 |
| `strong_hero_man` | 4 |
| `strong_hero_woman` | 5 |
| `mad_scientist_man` | 6 |
| `mad_scientist_woman` | 7 |
| `clever_villain_man` | 8 |
| `clever_villain_woman` | 9 |
| `narrator_man` | 10 |
| `narrator_woman` | 11 |
| `wise_elder_man` | 12 |
| `wise_elder_woman` | 13 |
| `outgoing_anime_man` | 14 |
| `outgoing_anime_woman` | 15 |
| `scary_villain_man` | 16 |
| `scary_villain_woman` | 17 |
| `news_reporter_man` | 18 |
| `news_reporter_woman` | 19 |

## Emotions

Supported emotion labels:

- `neutral`
- `joy`
- `sadness`
- `anger`
- `fear`
- `surprise`
- `dismissive`
- `confusion`

`intensity` must be between `0.0` and `1.0`.

## More

- Docs: https://docs.wfloat.com
- Model card, voices, emotions, and samples: https://huggingface.co/Wfloat/wfloat-tts
- Web package: https://github.com/wfloat/wfloat-web
- React Native package: https://github.com/wfloat/react-native-wfloat
