"""Dependency-free portable schema tests plus optional real Pydantic tests."""
import builtins
from dataclasses import dataclass
import importlib.util
import json
from pathlib import Path
from typing import Optional
import unittest
from unittest.mock import patch

from wfloat._schemas import (
    normalize_schema, SchemaConfigurationError, SchemaValidationError,
    SchemaResourceError, json_snapshot,
)


class SchemaSurfaceTests(unittest.TestCase):
    def test_shared_native_fixtures(self):
        fixtures = Path(__file__).resolve().parents[3] / "tests/schema/cases.json"
        for case in json.loads(fixtures.read_text(encoding="utf-8")):
            with self.subTest(case=case["name"]):
                if "value" not in case or case.get("code") in ("invalidSchema", "unsupportedSchema"):
                    if case["valid"]:
                        normalize_schema(case["schema"])
                    else:
                        with self.assertRaises(SchemaConfigurationError):
                            normalize_schema(case["schema"])
                    continue
                adapter = normalize_schema(case["schema"])
                if case["valid"]:
                    self.assertEqual(adapter.parse(case["value"]), case["value"])
                else:
                    with self.assertRaises(SchemaValidationError) as raised:
                        adapter.parse(case["value"])
                    if "instancePath" in case:
                        self.assertEqual(raised.exception.instance_path, case["instancePath"])
                    if "schemaPath" in case:
                        self.assertEqual(raised.exception.schema_path, case["schemaPath"])

    def test_no_optional_import_for_plain_schema(self):
        original = builtins.__import__
        def importing(name, *args, **kwargs):
            if name.startswith("pydantic"):
                raise AssertionError("Plain schemas imported Pydantic")
            return original(name, *args, **kwargs)
        with patch("builtins.__import__", side_effect=importing):
            self.assertIsNone(normalize_schema({"type": "null"}).parse(None))

    def test_snapshot_and_normalized_schema(self):
        schema = {"properties": {"n": {"type": "integer"}}}
        adapter = normalize_schema(schema)
        self.assertIs(normalize_schema(adapter), adapter)
        schema["properties"]["n"]["type"] = "string"
        adapter.json_schema["properties"].clear()
        raw = {"n": 2, "list": [1]}
        parsed = adapter.parse(raw)
        parsed["list"].append(2)
        self.assertEqual(raw["list"], [1])
        with self.assertRaises(SchemaValidationError):
            adapter.parse({"n": "2"})

    def test_strict_json(self):
        cycle = []
        cycle.append(cycle)
        for bad in (float("nan"), float("inf"), object(), (1,), {1: "x"}, cycle, "\ud800"):
            with self.subTest(value=type(bad)):
                with self.assertRaises(TypeError):
                    json_snapshot(bad)
                with self.assertRaises(SchemaValidationError):
                    normalize_schema({}).parse(bad)
        shared = []
        self.assertEqual(json_snapshot([shared, shared]), [[], []])

    def test_invalid_unused_branches_and_unknown_keywords(self):
        for bad in ({"anyOf": [{}, {"format": "email"}]},
                    {"$defs": {"unused": {"pattern": "x"}}},
                    {"type": ["string", []]}, {"required": [[]]},
                    {"minimum": True}, {"enum": [1, 1.0]},
                    {"properties": {"a": {"type": "str"}}}):
            with self.subTest(schema=bad):
                with self.assertRaises(SchemaConfigurationError):
                    normalize_schema(bad)

    def test_resource_error_not_swallowed_by_alternative(self):
        value = list(range(500))
        with self.assertRaises(SchemaResourceError):
            normalize_schema({"anyOf": [{}, {"uniqueItems": True}]}).parse(value)

    def test_boolean_schema_has_dict_transport(self):
        self.assertEqual(normalize_schema(True).json_schema, {})
        adapter = normalize_schema(False)
        self.assertIsInstance(adapter.json_schema, dict)
        with self.assertRaises(SchemaValidationError):
            adapter.parse(None)

    def test_missing_optional_dependency_clear_error(self):
        @dataclass
        class Input:
            n: int
        original = builtins.__import__
        def importing(name, *args, **kwargs):
            if name == "pydantic":
                raise ImportError("not installed")
            return original(name, *args, **kwargs)
        with patch("builtins.__import__", side_effect=importing):
            with self.assertRaisesRegex(SchemaConfigurationError, "Pydantic v2"):
                normalize_schema(Input)


@unittest.skipUnless(importlib.util.find_spec("pydantic"), "Optional Pydantic is not installed")
class PydanticSchemaTests(unittest.TestCase):
    def test_model_transform_defaults_nested_and_raw(self):
        from pydantic import BaseModel, field_validator
        class Child(BaseModel):
            value: int
        class Input(BaseModel):
            child: Child
            quantity: str
            defaulted: int = 3
            @field_validator("quantity")
            @classmethod
            def transform(cls, value):
                return int(value) * 2
        adapter = normalize_schema(Input)
        self.assertEqual(adapter.json_schema["properties"]["quantity"]["type"], "string")
        raw = {"child": {"value": 1}, "quantity": "4"}
        parsed = adapter.parse(raw)
        self.assertIsInstance(parsed, Input)
        self.assertIsInstance(parsed.child, Child)
        self.assertEqual(parsed.quantity, 8)
        self.assertEqual(parsed.defaulted, 3)
        self.assertEqual(raw, {"child": {"value": 1}, "quantity": "4"})
        with self.assertRaises(SchemaValidationError):
            adapter.parse({"quantity": "x"})

    def test_dataclass(self):
        @dataclass
        class Input:
            count: int
        parsed = normalize_schema(Input).parse({"count": "2"})
        self.assertIsInstance(parsed, Input)
        self.assertEqual(parsed.count, 2)

    def test_unsupported_pydantic_constraint(self):
        from pydantic import BaseModel, Field
        class Input(BaseModel):
            code: str = Field(pattern="[a-z]+")
        with self.assertRaises(SchemaConfigurationError):
            normalize_schema(Input)

    def test_parser_bug_not_misclassified(self):
        from pydantic import BaseModel, field_validator
        class Input(BaseModel):
            n: int
            @field_validator("n")
            @classmethod
            def broken(cls, value):
                raise TypeError("application bug")
        with self.assertRaisesRegex(TypeError, "application bug"):
            normalize_schema(Input).parse({"n": 1})

    def test_recursive_model_fails_upfront(self):
        from pydantic import BaseModel
        class Node(BaseModel):
            child: "Optional[Node]" = None
        Node.model_rebuild()
        with self.assertRaises(SchemaConfigurationError):
            normalize_schema(Node)


if __name__ == "__main__":
    unittest.main()
