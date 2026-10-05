"""ctypes binding to the same structured llama runtime used by React Native.

NativeLanguageBackend accepts the web LanguageBackend request dictionaries (camel
case fields and structured assistant parts). inspect_input returns inputTokens,
capacityTokens and fits. round is lazy and must be exhausted or closed; closing
releases native round state without advancing inference. Only cancellation-event
setting is supported concurrently. No prompt templates or output parsers live here.
"""
from __future__ import annotations

import ctypes
import json
import os
from pathlib import Path
import sys
import threading
import warnings
from contextlib import contextmanager, nullcontext


class NativeLlmError(RuntimeError):
    """The shared structured LLM runtime rejected an operation."""


def _encode(value):
    return json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(",", ":")).encode("utf-8")


def _load_library(library_path=None):
    explicit = library_path or os.environ.get("WFLOAT_LLM_LIBRARY")
    suffix = ".dll" if sys.platform == "win32" else ".dylib" if sys.platform == "darwin" else ".so"
    prefix = "" if sys.platform == "win32" else "lib"
    native = Path(__file__).resolve().parent / "native"
    candidates = [Path(explicit)] if explicit else [
        native / (prefix + "wfloat-python-llm" + suffix),
        native / (prefix + "wfloat-core" + suffix),
    ]
    failures = []
    for path in candidates:
        try:
            # Python 3.8+ uses restricted DLL dependency lookup on Windows.
            # Dependencies are bundled beside the bridge in a wheel.
            directory = (os.add_dll_directory(str(path.resolve().parent))
                         if sys.platform == "win32" and path.parent.is_dir() else nullcontext())
            with directory:
                lib = ctypes.CDLL(str(path.resolve()))
            signatures = {
                "abi_version": (ctypes.c_int, []),
                "error": (ctypes.c_char_p, []),
                "free": (None, [ctypes.c_void_p]),
                "create": (ctypes.c_void_p, [ctypes.c_char_p, ctypes.c_int, ctypes.c_int, ctypes.c_char_p]),
                "context_size": (ctypes.c_int, [ctypes.c_void_p]),
                "destroy": (None, [ctypes.c_void_p]),
                "count": (ctypes.c_void_p, [ctypes.c_void_p, ctypes.c_char_p]),
                "begin": (ctypes.c_void_p, [ctypes.c_void_p, ctypes.c_char_p]),
                "step": (ctypes.c_void_p, [ctypes.c_void_p, ctypes.c_int]),
                "end": (None, [ctypes.c_void_p]),
                "schema": (ctypes.c_void_p, [ctypes.c_char_p]),
            }
            for name, (result, args) in signatures.items():
                fn = getattr(lib, "wfloat_python_llm_" + name)
                fn.restype, fn.argtypes = result, args
            if lib.wfloat_python_llm_abi_version() != 1:
                raise RuntimeError("Unsupported structured LLM bridge ABI version")
            return lib
        except (OSError, AttributeError, RuntimeError) as exc:
            failures.append(f"{path}: {exc}")
    raise NativeLlmError("Structured LLM runtime unavailable. Build native/wfloat-python-llm or set "
                         "WFLOAT_LLM_LIBRARY to its shared library. Legacy wfloat_llm is incompatible.\n" + "\n".join(failures))


class NativeLlmBridge:
    """Single-model low-level binding using native request/event dictionaries."""

    def __init__(self, model_path, *, context_size=4096, num_threads=1,
                 chat_template=None, library_path=None):
        for name, value in (("context_size", context_size), ("num_threads", num_threads)):
            if isinstance(value, bool) or not isinstance(value, int):
                raise TypeError(f"{name} must be an integer")
            if not 0 < value <= 2147483647:
                raise ValueError(f"{name} must be a positive 32-bit integer")
        path = str(Path(model_path).expanduser().resolve())
        if "\0" in path:
            raise ValueError("model_path contains a NUL byte")
        if chat_template is not None and not isinstance(chat_template, str):
            raise TypeError("chat_template must be a string or None")
        if chat_template is not None and "\0" in chat_template:
            raise ValueError("chat_template contains a NUL byte")
        self._lock = threading.Lock()
        self._model = None
        self._round = None
        self._lib = _load_library(library_path)
        self._model = self._lib.wfloat_python_llm_create(
            path.encode("utf-8"), context_size, num_threads,
            chat_template.encode("utf-8") if chat_template is not None else None)
        if not self._model:
            self._raise_error()
        self.context_size = self._lib.wfloat_python_llm_context_size(self._model)

    @contextmanager
    def _guard(self):
        if not self._lock.acquire(blocking=False):
            raise RuntimeError("Concurrent native model operations are not supported")
        try:
            if not self._model:
                raise RuntimeError("Language model is unloaded")
            yield
        finally:
            self._lock.release()

    def _raise_error(self):
        message = self._lib.wfloat_python_llm_error()
        raise NativeLlmError(message.decode("utf-8", errors="replace") if message else "Native LLM operation failed")

    def _take(self, pointer):
        if not pointer:
            self._raise_error()
        try:
            return json.loads(ctypes.string_at(pointer))
        finally:
            self._lib.wfloat_python_llm_free(pointer)

    def count(self, request):
        payload = _encode(request)
        with self._guard():
            return self._take(self._lib.wfloat_python_llm_count(self._model, payload))

    def begin(self, request):
        payload = _encode(request)
        with self._guard():
            if self._round:
                raise RuntimeError("A round is already active on this model")
            self._round = self._lib.wfloat_python_llm_begin(self._model, payload)
            if not self._round:
                self._raise_error()

    def step(self, cancel=False):
        with self._guard():
            if not self._round:
                raise RuntimeError("No native round is active")
            return self._take(self._lib.wfloat_python_llm_step(self._round, bool(cancel)))

    def end_round(self):
        with self._guard():
            if self._round:
                self._lib.wfloat_python_llm_end(self._round)
                self._round = None

    def schema(self, request):
        payload = _encode(request)
        with self._guard():
            return self._take(self._lib.wfloat_python_llm_schema(payload))

    def check_schema(self, schema):
        return self.schema({"schema": schema, "validate": False})

    def validate_schema(self, schema, value):
        return self.schema({"schema": schema, "value": value, "validate": True})

    def generate_round(self, request, cancel_event=None):
        self.begin(request)
        try:
            done = False
            while not done:
                events = self.step(cancel_event is not None and cancel_event.is_set())
                for event in events:
                    done = done or event["type"] == "done"
                    yield event
        finally:
            # unload can safely release a suspended iterator's round first.
            if self._model:
                self.end_round()

    def unload(self):
        if not self._lock.acquire(blocking=False):
            raise RuntimeError("Cannot unload during a native model operation")
        try:
            if self._round:
                self._lib.wfloat_python_llm_end(self._round)
                self._round = None
            if self._model:
                self._lib.wfloat_python_llm_destroy(self._model)
                self._model = None
        finally:
            self._lock.release()

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.unload()

    def __del__(self):
        # Construction may fail before the lock/library exists; interpreter
        # teardown may also have cleared module globals. Explicit unload stays
        # the deterministic cleanup path. Never wait on in-flight native work.
        try:
            self.unload()
        except Exception:
            pass


def _normalize(request):
    """Translate conversation records to upstream OA-compatible structures."""
    result = dict(request)
    names = {}
    messages = []
    for message in request["messages"]:
        role = message["role"]
        if role == "tool" and "callId" in message:
            call_id = message["callId"]
            output = message.get("output") if message["status"] == "completed" else {
                k: message[k] for k in ("status", "error") if k in message}
            entry = {"role": "tool", "tool_call_id": call_id, "content": _encode(output).decode()}
            if call_id in names:
                entry["name"] = names[call_id]
        elif role == "assistant" and isinstance(message.get("content"), list):
            entry = {"role": role, "content": "", "reasoning_content": "", "tool_calls": []}
            for part in message["content"]:
                kind = part["type"]
                if kind == "text":
                    entry["content"] += part["text"]
                elif kind == "reasoning":
                    entry["reasoning_content"] += part["text"]
                elif kind == "toolCall":
                    names[part["id"]] = part["name"]
                    entry["tool_calls"].append({"id": part["id"], "type": "function", "function": {
                        "name": part["name"], "arguments": _encode(part["arguments"]).decode()}})
                else:
                    raise ValueError(f"Unsupported assistant content part: {kind}")
        else:
            entry = dict(message)
            for call in entry.get("tool_calls", []):
                names[call["id"]] = call["function"]["name"]
        messages.append(entry)
    result["messages"] = messages
    if isinstance(result.get("tools"), dict):
        result["tools"] = [{"type": "function", "function": {
            "name": name, "parameters": tool["inputSchema"],
            **({"description": tool["description"]} if tool.get("description") is not None else {})}}
            for name, tool in result["tools"].items()]
    if "structuredOutput" in result:
        result["jsonSchema"] = result.pop("structuredOutput")
    return result


class NativeLanguageBackend(NativeLlmBridge):
    """Language orchestration adapter. Inputs use the web backend wire shape."""

    def __init__(self, model_path, *, context_size=4096, num_threads=1,
                 chat_template=None, library_path=None):
        super().__init__(model_path, context_size=context_size, num_threads=num_threads,
                         chat_template=chat_template, library_path=library_path)
        self._call_serial = 0

    def inspect_input(self, request):
        count = self.count(_normalize(request))
        return {"inputTokens": count, "capacityTokens": self.context_size, "fits": count < self.context_size}

    def round(self, request, cancel_event=None):
        native_request = _normalize(request)
        history_ids = {call["id"] for message in native_request["messages"] for call in message.get("tool_calls", [])}
        history_ids.update(message["tool_call_id"] for message in native_request["messages"] if "tool_call_id" in message)
        stream = self.generate_round(native_request, cancel_event)
        try:
            for event in stream:
                kind = event["type"]
                if kind == "warning":
                    warnings.warn(event["message"], RuntimeWarning, stacklevel=2)
                    continue
                if kind == "toolCall":
                    arguments = json.loads(event["rawArguments"])
                    while True:
                        self._call_serial += 1
                        serial, digits = self._call_serial, ""
                        while serial:
                            serial, remainder = divmod(serial, 36)
                            digits = "0123456789abcdefghijklmnopqrstuvwxyz"[remainder] + digits
                        call_id = digits.rjust(9, "0")
                        if len(call_id) > 9:
                            raise RuntimeError("Tool call ID space exhausted")
                        if call_id not in history_ids:
                            break
                    history_ids.add(call_id)
                    yield {"type": "toolCall", "call": {"id": call_id, "name": event["name"], "arguments": arguments}}
                elif kind == "done":
                    # Parent owns operation-level cancellation, as in web.
                    event = dict(event)
                    if event["stopReason"] == "cancelled":
                        event["stopReason"] = "complete"
                    if event["stopReason"] == "contextLimit":
                        event["contextLimit"] = {"phase": "input" if event["inputTokens"] >= self.context_size else "generation",
                                                 "capacityTokens": self.context_size, "inputTokens": event["inputTokens"]}
                    yield event
                else:
                    yield event
        finally:
            stream.close()
