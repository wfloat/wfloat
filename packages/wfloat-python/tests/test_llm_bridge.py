"""Run native coverage with WFLOAT_LLM_LIBRARY and WFLOAT_TEST_GGUF set.

These tests import only the bridge, allowing validation while the package's
public orchestration/exports are being migrated independently.
"""
import importlib.util
import gc
import json
import os
from pathlib import Path
import threading
import unittest

SOURCE = Path(__file__).resolve().parents[1] / "python/wfloat/_llm_bridge.py"
spec = importlib.util.spec_from_file_location("llm_bridge_under_test", SOURCE)
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)


class AdapterTests(unittest.TestCase):
    def test_conversation_roundtrip_preserves_reasoning_and_raw_arguments(self):
        request = {"messages": [
            {"role": "assistant", "content": [
                {"type": "reasoning", "text": "thinking"}, {"type": "text", "text": "answer"},
                {"type": "toolCall", "id": "000000001", "name": "weather", "arguments": {"city": "東京"}}]},
            {"role": "tool", "callId": "000000001", "status": "completed", "output": None}],
            "tools": {"weather": {"inputSchema": {"type": "object"}}}, "reasoning": False}
        normalized = bridge._normalize(request)
        self.assertEqual(normalized["messages"][0]["reasoning_content"], "thinking")
        self.assertEqual(json.loads(normalized["messages"][0]["tool_calls"][0]["function"]["arguments"]), {"city": "東京"})
        self.assertEqual(normalized["messages"][1], {"role": "tool", "tool_call_id": "000000001", "name": "weather", "content": "null"})
        self.assertEqual(request["messages"][0]["content"][0]["type"], "reasoning")
        self.assertFalse(normalized["reasoning"])

    def test_null_schema_and_nonfinite_json(self):
        self.assertIn("jsonSchema", bridge._normalize({"messages": [], "structuredOutput": None}))
        with self.assertRaises(ValueError):
            bridge._encode({"temperature": float("nan")})

    def test_bad_load_options_before_native_work(self):
        for value in (0, -1, 2**40):
            with self.assertRaises(ValueError):
                bridge.NativeLanguageBackend("missing", context_size=value)
        with self.assertRaises(TypeError):
            bridge.NativeLanguageBackend("missing", num_threads=True)
        with self.assertRaises(bridge.NativeLlmError):
            bridge.NativeLanguageBackend("missing", library_path="/nonexistent/bridge.so")

    def test_finalizer_releases_round_before_model_and_tolerates_partial_init(self):
        calls = []
        class Library:
            def wfloat_python_llm_end(self, handle):
                calls.append(("round", handle))
            def wfloat_python_llm_destroy(self, handle):
                calls.append(("model", handle))
        backend = object.__new__(bridge.NativeLlmBridge)
        backend._lock = threading.Lock()
        backend._lib = Library()
        backend._model = 123
        backend._round = 456
        del backend
        gc.collect()
        self.assertEqual(calls, [("round", 456), ("model", 123)])
        partial = object.__new__(bridge.NativeLlmBridge)
        partial.__del__()

    def test_tool_ids_do_not_collide_and_cancel_maps_to_complete(self):
        backend = object.__new__(bridge.NativeLanguageBackend)
        backend.context_size = 128
        backend._call_serial = 0
        closed = []
        def events(*_):
            try:
                yield {"type": "toolCall", "name": "weather", "rawArguments": '{"city":"Paris"}'}
                yield {"type": "done", "stopReason": "cancelled", "inputTokens": 5, "outputTokens": 2}
            finally:
                closed.append(True)
        backend.generate_round = events
        request = {"messages": [{"role": "tool", "tool_call_id": "000000001", "content": "null"}]}
        result = list(backend.round(request))
        self.assertEqual(result[0]["call"], {"id": "000000002", "name": "weather", "arguments": {"city": "Paris"}})
        self.assertEqual(result[-1]["stopReason"], "complete")
        self.assertEqual(closed, [True])

    def test_malformed_tool_arguments_fail_and_close(self):
        backend = object.__new__(bridge.NativeLanguageBackend)
        backend._call_serial = 0
        closed = []
        def events(*_):
            try:
                yield {"type": "toolCall", "name": "bad", "rawArguments": '{"a":'}
            finally:
                closed.append(True)
        backend.generate_round = events
        with self.assertRaises(ValueError):
            list(backend.round({"messages": []}))
        self.assertEqual(closed, [True])


@unittest.skipUnless(os.environ.get("WFLOAT_LLM_LIBRARY") and os.environ.get("WFLOAT_TEST_GGUF"), "native bridge/model paths not configured")
class NativeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.backend = bridge.NativeLanguageBackend(os.environ["WFLOAT_TEST_GGUF"], context_size=256, num_threads=2)

    @classmethod
    def tearDownClass(cls):
        cls.backend.unload()
        cls.backend.unload()

    def request(self, **options):
        return {"messages": [{"role": "user", "content": "Say hello."}], "maxTokensPerRound": 8,
                "temperature": 0, "seed": 7, **options}

    def test_real_generation_count_cache_and_early_close(self):
        info = self.backend.inspect_input(self.request())
        self.assertGreater(info["inputTokens"], 0)
        self.assertTrue(info["fits"])
        first = list(self.backend.round(self.request()))
        self.assertEqual(first[-1]["inputTokens"], info["inputTokens"])
        self.assertGreater(first[-1]["outputTokens"], 0)
        self.assertTrue(any(e["type"] == "text" and e["text"] for e in first))
        second = list(self.backend.round(self.request()))
        self.assertGreater(second[-1]["cachedInputTokens"], 0)
        stream = self.backend.round(self.request())
        next(stream)
        with self.assertRaisesRegex(RuntimeError, "already active"):
            next(self.backend.round(self.request()))
        stream.close()
        self.assertEqual(list(self.backend.round(self.request()))[-1]["type"], "done")

    def test_cancel_before_and_during_prefill(self):
        stop = threading.Event()
        stop.set()
        result = list(self.backend.generate_round(self.request(), stop))
        self.assertEqual(result[-1]["stopReason"], "cancelled")
        self.assertEqual(result[-1]["outputTokens"], 0)
        self.assertTrue(stop.is_set())
        stop.clear()
        stream = self.backend.generate_round(self.request(), stop)
        next(stream)
        stop.set()
        self.assertEqual(list(stream)[-1]["stopReason"], "cancelled")

    def test_context_limit(self):
        request = self.request(messages=[{"role": "user", "content": "hello " * 400}])
        info = self.backend.inspect_input(request)
        self.assertFalse(info["fits"])
        terminal = list(self.backend.round(request))[-1]
        self.assertEqual(terminal["stopReason"], "contextLimit")
        self.assertEqual(terminal["contextLimit"]["phase"], "input")
        self.assertEqual(terminal["outputTokens"], 0)

    def test_native_schema_and_grammar_generation(self):
        schema = {"type": "object", "properties": {"ok": {"const": True}}, "required": ["ok"], "additionalProperties": False}
        self.assertTrue(self.backend.check_schema(schema)["valid"])
        self.assertFalse(self.backend.validate_schema(schema, {"ok": False})["valid"])
        self.assertTrue(self.backend.validate_schema({"type": "null"}, None)["valid"])
        events = list(self.backend.round(self.request(structuredOutput=schema, maxTokensPerRound=40)))
        value = json.loads("".join(e["text"] for e in events if e["type"] == "text"))
        self.assertEqual(value, {"ok": True})
        self.assertEqual(events[-1]["stopReason"], "complete")

    def test_native_error_cleanup(self):
        with self.assertRaises(bridge.NativeLlmError):
            list(self.backend.round(self.request(maxTokensPerRound=0)))
        self.assertEqual(list(self.backend.round(self.request()))[-1]["type"], "done")
        with self.assertRaises(bridge.NativeLlmError):
            bridge.NativeLanguageBackend("/nonexistent/model.gguf")

    def test_unload_suspended_round(self):
        backend = bridge.NativeLanguageBackend(os.environ["WFLOAT_TEST_GGUF"], context_size=128)
        stream = backend.round(self.request())
        next(stream)
        backend.unload()
        stream.close()
        with self.assertRaisesRegex(RuntimeError, "unloaded"):
            backend.inspect_input(self.request())


if __name__ == "__main__":
    unittest.main()
