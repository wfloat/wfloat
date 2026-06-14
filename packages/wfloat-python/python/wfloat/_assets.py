from dataclasses import dataclass
from pathlib import Path
from typing import Dict, Mapping, Optional
from urllib.parse import urlparse

REGISTRY_BASE_URL = "https://registry.wfloat.com"
WFLOAT_TTS_MODEL_ID = "wfloat/wfloat-tts"
SILERO_VAD_MODEL_ID = "snakers4/silero-vad"
SMOLLM2_360M_INSTRUCT_MODEL_ID = "HuggingFaceTB/SmolLM2-360M-Instruct"


@dataclass(frozen=True)
class ModelAssets:
    model_onnx: str
    model_onnx_checksum: str
    model_tokens: str
    model_tokens_checksum: str
    espeak_data: str
    espeak_checksum: str

    @classmethod
    def from_dict(cls, data: Dict[str, object]) -> "ModelAssets":
        required_fields = (
            "model_onnx",
            "model_onnx_checksum",
            "model_tokens",
            "model_tokens_checksum",
            "espeak_data",
            "espeak_checksum",
        )

        missing = [
            field_name
            for field_name in required_fields
            if not isinstance(data.get(field_name), str) or not str(data.get(field_name)).strip()
        ]
        if missing:
            raise ValueError(
                "Model asset response is missing required fields: %s"
                % ", ".join(missing)
            )

        return cls(
            model_onnx=str(data["model_onnx"]),
            model_onnx_checksum=str(data["model_onnx_checksum"]),
            model_tokens=str(data["model_tokens"]),
            model_tokens_checksum=str(data["model_tokens_checksum"]),
            espeak_data=str(data["espeak_data"]),
            espeak_checksum=str(data["espeak_checksum"]),
        )

    def to_dict(self) -> Dict[str, str]:
        return {
            "model_onnx": self.model_onnx,
            "model_onnx_checksum": self.model_onnx_checksum,
            "model_tokens": self.model_tokens,
            "model_tokens_checksum": self.model_tokens_checksum,
            "espeak_data": self.espeak_data,
            "espeak_checksum": self.espeak_checksum,
        }


@dataclass(frozen=True)
class SttModelAssets:
    family: str
    tokens: str
    tokens_checksum: Optional[str] = None
    model: Optional[str] = None
    model_checksum: Optional[str] = None
    preprocessor: Optional[str] = None
    preprocessor_checksum: Optional[str] = None
    encoder: Optional[str] = None
    encoder_checksum: Optional[str] = None
    decoder: Optional[str] = None
    decoder_checksum: Optional[str] = None
    joiner: Optional[str] = None
    joiner_checksum: Optional[str] = None
    uncached_decoder: Optional[str] = None
    uncached_decoder_checksum: Optional[str] = None
    cached_decoder: Optional[str] = None
    cached_decoder_checksum: Optional[str] = None

    @classmethod
    def from_dict(cls, data: Dict[str, object]) -> "SttModelAssets":
        family = str(data.get("family") or "").strip()
        if not family:
            raise ValueError("STT asset response is missing required field: family")

        files = data.get("files")
        if isinstance(files, Mapping):
            normalized: Dict[str, str] = {}
            for key, value in files.items():
                if not isinstance(key, str) or not isinstance(value, Mapping):
                    continue
                url = value.get("url")
                checksum = value.get("checksum")
                if isinstance(url, str) and url.strip():
                    normalized[key] = url
                if isinstance(checksum, str) and checksum.strip():
                    normalized[f"{key}_checksum"] = checksum
            merged = dict(data)
            merged.update(normalized)
            data = merged

        required_fields = ("tokens",)
        missing = [
            field_name
            for field_name in required_fields
            if not isinstance(data.get(field_name), str)
            or not str(data.get(field_name)).strip()
        ]
        if missing:
            raise ValueError(
                "STT asset response is missing required fields: %s"
                % ", ".join(missing)
            )

        def optional_string(key: str) -> Optional[str]:
            value = data.get(key)
            if isinstance(value, str) and value.strip():
                return value.strip()
            return None

        return cls(
            family=family,
            tokens=str(data["tokens"]).strip(),
            tokens_checksum=optional_string("tokens_checksum"),
            model=optional_string("model"),
            model_checksum=optional_string("model_checksum"),
            preprocessor=optional_string("preprocessor"),
            preprocessor_checksum=optional_string("preprocessor_checksum"),
            encoder=optional_string("encoder"),
            encoder_checksum=optional_string("encoder_checksum"),
            decoder=optional_string("decoder"),
            decoder_checksum=optional_string("decoder_checksum"),
            joiner=optional_string("joiner"),
            joiner_checksum=optional_string("joiner_checksum"),
            uncached_decoder=optional_string("uncached_decoder"),
            uncached_decoder_checksum=optional_string("uncached_decoder_checksum"),
            cached_decoder=optional_string("cached_decoder"),
            cached_decoder_checksum=optional_string("cached_decoder_checksum"),
        )

    def to_dict(self) -> Dict[str, str]:
        data = {
            "family": self.family,
            "tokens": self.tokens,
        }
        optional_fields = {
            "tokens_checksum": self.tokens_checksum,
            "model": self.model,
            "model_checksum": self.model_checksum,
            "preprocessor": self.preprocessor,
            "preprocessor_checksum": self.preprocessor_checksum,
            "encoder": self.encoder,
            "encoder_checksum": self.encoder_checksum,
            "decoder": self.decoder,
            "decoder_checksum": self.decoder_checksum,
            "joiner": self.joiner,
            "joiner_checksum": self.joiner_checksum,
            "uncached_decoder": self.uncached_decoder,
            "uncached_decoder_checksum": self.uncached_decoder_checksum,
            "cached_decoder": self.cached_decoder,
            "cached_decoder_checksum": self.cached_decoder_checksum,
        }
        for key, value in optional_fields.items():
            if value:
                data[key] = value
        return data


@dataclass(frozen=True)
class VadModelAssets:
    family: str
    model: str
    model_checksum: Optional[str] = None

    @classmethod
    def from_dict(cls, data: Dict[str, object]) -> "VadModelAssets":
        family = str(data.get("family") or "").strip()
        if not family:
            raise ValueError("VAD asset response is missing required field: family")

        files = data.get("files")
        if isinstance(files, Mapping):
            model_file = files.get("model")
            if isinstance(model_file, Mapping):
                merged = dict(data)
                url = model_file.get("url")
                checksum = model_file.get("checksum")
                if isinstance(url, str) and url.strip():
                    merged["model"] = url
                if isinstance(checksum, str) and checksum.strip():
                    merged["model_checksum"] = checksum
                data = merged

        model = str(data.get("model") or "").strip()
        if not model:
            raise ValueError("VAD asset response is missing required field: model")

        def optional_string(key: str) -> Optional[str]:
            value = data.get(key)
            if isinstance(value, str) and value.strip():
                return value.strip()
            return None

        return cls(
            family=family,
            model=model,
            model_checksum=optional_string("model_checksum"),
        )

    def to_dict(self) -> Dict[str, str]:
        data = {
            "family": self.family,
            "model": self.model,
        }
        if self.model_checksum:
            data["model_checksum"] = self.model_checksum
        return data


@dataclass(frozen=True)
class LlmModelAssets:
    family: str
    model: str
    model_checksum: Optional[str] = None
    context_size: Optional[int] = None
    chat_template: Optional[str] = None
    chat_template_format: Optional[str] = None

    @classmethod
    def from_dict(cls, data: Dict[str, object]) -> "LlmModelAssets":
        family = str(data.get("family") or "").strip()
        if not family:
            raise ValueError("LLM asset response is missing required field: family")

        files = data.get("files")
        if isinstance(files, Mapping):
            model_file = files.get("model")
            if isinstance(model_file, Mapping):
                merged = dict(data)
                url = model_file.get("url")
                checksum = model_file.get("checksum")
                if isinstance(url, str) and url.strip():
                    merged["model"] = url
                if isinstance(checksum, str) and checksum.strip():
                    merged["model_checksum"] = checksum
                data = merged

        model = str(data.get("model") or "").strip()
        if not model:
            raise ValueError("LLM asset response is missing required field: model")

        def optional_string(key: str) -> Optional[str]:
            value = data.get(key)
            if isinstance(value, str) and value.strip():
                return value.strip()
            return None

        context_size_value = data.get("context_size")
        context_size = None
        if context_size_value is not None:
            context_size = int(context_size_value)

        return cls(
            family=family,
            model=model,
            model_checksum=optional_string("model_checksum"),
            context_size=context_size,
            chat_template=optional_string("chat_template"),
            chat_template_format=optional_string("chat_template_format"),
        )

    def to_dict(self) -> Dict[str, object]:
        data: Dict[str, object] = {
            "family": self.family,
            "model": self.model,
        }
        if self.model_checksum:
            data["model_checksum"] = self.model_checksum
        if self.context_size is not None:
            data["context_size"] = self.context_size
        if self.chat_template:
            data["chat_template"] = self.chat_template
        if self.chat_template_format:
            data["chat_template_format"] = self.chat_template_format
        return data


def filename_from_url(url: str, fallback: str) -> str:
    parsed = urlparse(url)
    filename = Path(parsed.path).name
    return filename or fallback


def fetch_model_assets(model_name: str) -> ModelAssets:
    if model_name != WFLOAT_TTS_MODEL_ID:
        raise ValueError("Unsupported TTS model: %s" % model_name)

    return ModelAssets(
        model_onnx="%s/models/wfloat-model/1.0.2/wfloat-model-1.0.2.onnx" % REGISTRY_BASE_URL,
        model_onnx_checksum="a7e65773a29499b80a393bbe08af3507e18f6ef95faa0eaf7cb4ba353c8693ae",
        model_tokens="%s/models/wfloat-model/1.0.2/wfloat-model-1.0.2_tokens.txt"
        % REGISTRY_BASE_URL,
        model_tokens_checksum="96fd291bede0544469d4d8935d462fdd6dc947f22ad47369753e1a82db3d748e",
        espeak_data="%s/espeak-ng-data/espeak-ng-data-2023.9.7-4.zip" % REGISTRY_BASE_URL,
        espeak_checksum="56c2879ab1ab44c594c78f34e76c50cf1dd7b8f6ca0ca2634b6766a6edb32add",
    )


def fetch_stt_assets(model_name: str) -> SttModelAssets:
    if model_name == "openai/whisper-tiny-en":
        return SttModelAssets(
            family="whisper",
            encoder="%s/models/openai/whisper-tiny-en/tiny.en-encoder.int8.onnx"
            % REGISTRY_BASE_URL,
            decoder="%s/models/openai/whisper-tiny-en/tiny.en-decoder.int8.onnx"
            % REGISTRY_BASE_URL,
            tokens="%s/models/openai/whisper-tiny-en/tiny.en-tokens.txt" % REGISTRY_BASE_URL,
        )

    if model_name == "k2-fsa/streaming-zipformer-en":
        return SttModelAssets(
            family="zipformer-transducer",
            encoder="%s/models/k2-fsa/streaming-zipformer-en/encoder-epoch-99-avg-1.int8.onnx"
            % REGISTRY_BASE_URL,
            decoder="%s/models/k2-fsa/streaming-zipformer-en/decoder-epoch-99-avg-1.onnx"
            % REGISTRY_BASE_URL,
            joiner="%s/models/k2-fsa/streaming-zipformer-en/joiner-epoch-99-avg-1.onnx"
            % REGISTRY_BASE_URL,
            tokens="%s/models/k2-fsa/streaming-zipformer-en/tokens.txt" % REGISTRY_BASE_URL,
        )

    if model_name == "UsefulSensors/moonshine-tiny":
        return SttModelAssets(
            family="moonshine",
            preprocessor="%s/models/usefulsensors-moonshine-tiny/preprocessor.onnx"
            % REGISTRY_BASE_URL,
            encoder="%s/models/usefulsensors-moonshine-tiny/encoder.int8.onnx"
            % REGISTRY_BASE_URL,
            uncached_decoder="%s/models/usefulsensors-moonshine-tiny/uncached_decoder.int8.onnx"
            % REGISTRY_BASE_URL,
            cached_decoder="%s/models/usefulsensors-moonshine-tiny/cached_decoder.int8.onnx"
            % REGISTRY_BASE_URL,
            tokens="%s/models/usefulsensors-moonshine-tiny/tokens.txt" % REGISTRY_BASE_URL,
        )

    raise ValueError("Unsupported STT model: %s" % model_name)


def fetch_vad_assets(model_name: str) -> VadModelAssets:
    if model_name != SILERO_VAD_MODEL_ID:
        raise ValueError("Unsupported VAD model: %s" % model_name)

    return VadModelAssets(
        family="silero-vad",
        model="%s/models/snakers4/silero-vad/silero_vad.onnx" % REGISTRY_BASE_URL,
    )


def fetch_llm_assets(model_name: str) -> LlmModelAssets:
    if model_name != SMOLLM2_360M_INSTRUCT_MODEL_ID:
        raise ValueError("Unsupported LLM model: %s" % model_name)

    return LlmModelAssets(
        family="smollm",
        model="%s/models/huggingface/smollm2-360m-instruct/SmolLM2-360M-Instruct.Q4_K_M.gguf"
        % REGISTRY_BASE_URL,
        model_checksum="75c4346ef9e855ed630f80078a2430cf63aaca599e340360998a313070fcdc47",
        context_size=8192,
        chat_template_format="chatml",
    )
