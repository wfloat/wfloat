from functools import partial
from dataclasses import dataclass
from threading import Event
import unittest

from wfloat._schemas import normalize_schema, SchemaValidationError
from wfloat._tools import define_tool, execute_tool, ToolContext, ToolDefinition, ToolOutputError, validate_tool_output


class ToolSurfaceTests(unittest.TestCase):
    def test_manual_and_normalized(self):
        adapter = normalize_schema({"type": "object"})
        tool = define_tool("manual", adapter, description="Description")
        self.assertIsInstance(tool, ToolDefinition)
        self.assertIs(tool.input_schema, adapter)
        self.assertEqual(tool.description, "Description")
        self.assertEqual(tool.parse_arguments({}), {})
        with self.assertRaises(TypeError):
            execute_tool(tool, {}, ToolContext(Event()))

    def test_execute_parsed_copy_and_null(self):
        raw = {"values": [1]}
        def execute(args):
            args["values"].append(2)
            return None
        tool = define_tool("mutate", {"type": "object"}, execute=execute)
        self.assertIsNone(execute_tool(tool, tool.parse_arguments(raw), ToolContext(Event())))
        self.assertEqual(raw, {"values": [1]})
        with self.assertRaises(SchemaValidationError):
            tool.parse_arguments(None)

    def test_explicit_keyword_context_only(self):
        context = ToolContext(Event())
        def execute(args, *, context):
            return context.cancel_event.is_set()
        tool = define_tool("context", {}, execute=execute)
        self.assertFalse(execute_tool(tool, {}, context))
        context.cancel_event.set()
        self.assertTrue(execute_tool(tool, {}, context))
        self.assertTrue(context.cancel_event.is_set())
        def kwargs(args, **kwargs):
            return kwargs
        self.assertEqual(execute_tool(define_tool("kwargs", {}, execute=kwargs), {}, context), {})
        def positional(args, context="default"):
            return context
        self.assertEqual(execute_tool(define_tool("pos", {}, execute=positional), {}, context), "default")

    def test_direct_definition_preflights_and_injects(self):
        context = ToolContext(Event())
        def execute(args, *, context):
            return context.cancel_event.is_set()
        tool = ToolDefinition("direct", {"type": "integer"}, execute)
        self.assertEqual(tool.parse_arguments(1), 1)
        self.assertFalse(execute_tool(tool, 1, context))
        with self.assertRaises(TypeError):
            ToolDefinition("invalid", {}, lambda first, second: None)

    def test_output_error_separate_from_executor_type_error(self):
        with self.assertRaises(ToolOutputError):
            execute_tool(define_tool("bad", {}, execute=lambda args: object()), {}, ToolContext(Event()))
        failure = TypeError("executor bug")
        def execute(args):
            raise failure
        with self.assertRaises(TypeError) as raised:
            execute_tool(define_tool("bug", {}, execute=execute), {}, ToolContext(Event()))
        self.assertIs(raised.exception, failure)
        self.assertNotIsInstance(raised.exception, ToolOutputError)

    def test_callable_object(self):
        class Executor:
            def __call__(self, args, *, context):
                return context.cancel_event.is_set()
        self.assertFalse(execute_tool(define_tool("obj", {}, execute=Executor()), {}, ToolContext(Event())))

    def test_bad_signatures_and_async_fail_upfront(self):
        async def asynchronous(args):
            return args
        class AsyncObject:
            async def __call__(self, args):
                return args
        for execute in (42, lambda: None, lambda args, second: None, asynchronous, partial(asynchronous), AsyncObject()):
            with self.subTest(executor=execute):
                with self.assertRaises(TypeError):
                    define_tool("bad", {}, execute=execute)
        with self.assertRaises(ValueError):
            define_tool(" ", {})
        with self.assertRaises(TypeError):
            define_tool("bad", {}, description=2)

    def test_late_awaitable_rejected_without_warning(self):
        async def result():
            return None
        tool = define_tool("async_return", {}, execute=lambda args: result())
        with self.assertRaisesRegex(TypeError, "Async"):
            execute_tool(tool, {}, ToolContext(Event()))

    def test_outputs_strict_and_snapshot(self):
        @dataclass
        class Output:
            n: int
        cycle = {}
        cycle["self"] = cycle
        for value in (cycle, float("nan"), float("inf"), {2: "key"}, Output(1), b"bytes", (1,), object()):
            with self.subTest(value=type(value)):
                with self.assertRaises(TypeError):
                    execute_tool(define_tool("output", {}, execute=lambda args: value), {}, ToolContext(Event()))
        raw = {"values": [None, True, 1, 1.5, "text"]}
        snapshot = validate_tool_output(raw)
        raw["values"].clear()
        self.assertEqual(snapshot, {"values": [None, True, 1, 1.5, "text"]})

    def test_executor_exception_identity(self):
        failure = RuntimeError("executor failed")
        def execute(args):
            raise failure
        with self.assertRaises(RuntimeError) as raised:
            execute_tool(define_tool("raises", {}, execute=execute), {}, ToolContext(Event()))
        self.assertIs(raised.exception, failure)


if __name__ == "__main__":
    unittest.main()
