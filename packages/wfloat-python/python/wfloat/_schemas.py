"""Owned synchronous JSON Schema adapters (no required schema dependency).

Plain schemas implement the shared native validator's strict 2020-12 subset:
objects, arrays, primitive types, enum/const, numeric/length constraints and
combinators. Unknown keywords (including pattern, format and references) fail
upfront, even in unused branches. Defaults are annotations, never insertions.
The native C++ checker currently has no Python binding. Keep the shared fixture
suite passing when changing these portable rules.

Optional Pydantic v2 classes use TypeAdapter's validation-mode schema and parser.
Acyclic local references in generated schemas are expanded; recursive models and
constraints outside the portable subset fail upfront. Parsed transformations
run once, on a JSON snapshot, and cannot modify conversation history.
"""
from __future__ import annotations

from dataclasses import is_dataclass
from fractions import Fraction
import math
from typing import Any, Callable, Generic, TypeVar, Optional

T = TypeVar("T")


class SchemaConfigurationError(ValueError):
    """Malformed or unsupported developer schema; never model feedback."""


class SchemaValidationError(ValueError):
    """Invalid model data, suitable for validation feedback/correction."""

    def __init__(self, message: str, *, instance_path: str = "", schema_path: str = ""):
        super().__init__(f"{instance_path or '/'}: {message}")
        self.instance_path = instance_path
        self.schema_path = schema_path


class SchemaResourceError(RuntimeError):
    """Validation work limit exceeded; not an ordinary rejected value."""


class _Budget:
    def __init__(self):
        self.remaining = 100_000

    def visit(self):
        self.remaining -= 1
        if self.remaining < 0:
            raise SchemaResourceError("JSON/schema work limit exceeds 100000 visits")


def json_snapshot(value: Any) -> Any:
    """Copy strict JSON data; reject cycles, nonfinite numbers and coercions.

    Only built-in dict/list/str/int/float/bool and None are accepted. Tuples,
    custom objects, dataclasses and Pydantic results are not implicitly encoded.
    Shared (noncyclic) containers are allowed. Maximum depth is 128.
    """
    active: set[int] = set()
    budget = _Budget()

    def copy(item, depth):
        budget.visit()
        if depth > 128:
            raise SchemaResourceError("JSON nesting exceeds 128")
        kind = type(item)
        if item is None or kind in (bool, int):
            return item
        if kind is float:
            if not math.isfinite(item):
                raise TypeError("JSON numbers must be finite")
            return item
        if kind is str:
            try:
                item.encode("utf-8")
            except UnicodeEncodeError as error:
                raise TypeError("JSON strings must not contain unpaired surrogates") from error
            return item
        if kind not in (dict, list):
            raise TypeError(f"Unsupported JSON value: {kind.__name__}")
        if id(item) in active:
            raise TypeError("Cyclic JSON value")
        active.add(id(item))
        try:
            if kind is list:
                return [copy(child, depth + 1) for child in item]
            result = {}
            for key, child in item.items():
                if type(key) is not str:
                    raise TypeError("JSON object keys must be strings")
                result[copy(key, depth + 1)] = copy(child, depth + 1)
            return result
        finally:
            active.remove(id(item))

    return copy(value, 0)


def _at(path, key):
    return path + "/" + str(key).replace("~", "~0").replace("/", "~1")


def _number(value):
    return type(value) in (int, float)


def _decimal(value):
    # Fraction avoids Decimal's context rounding for multipleOf and large ints.
    return Fraction(str(value))


def _equal(a, b, budget):
    budget.visit()
    if _number(a) and _number(b):
        return _decimal(a) == _decimal(b)
    if type(a) is not type(b):
        return False
    if type(a) is list:
        return len(a) == len(b) and all(_equal(x, y, budget) for x, y in zip(a, b))
    if type(a) is dict:
        return a.keys() == b.keys() and all(_equal(a[k], b[k], budget) for k in a)
    return a == b


_TYPES = {"null", "boolean", "object", "array", "number", "integer", "string"}
_BOUNDS = {"minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf"}
_LENGTHS = {"minLength", "maxLength", "minItems", "maxItems", "minProperties", "maxProperties"}


def _check(schema, path, budget):
    budget.visit()
    if type(schema) is bool:
        return
    if type(schema) is not dict:
        raise SchemaConfigurationError(f"{path or '/'}: schema must be an object or boolean")
    for key, value in schema.items():
        location = _at(path, key)
        good = True
        if key == "type":
            names = value if type(value) is list else [value]
            good = bool(names) and all(type(n) is str and n in _TYPES for n in names)
            good = good and len(set(names)) == len(names)
        elif key in ("properties", "$defs"):
            good = type(value) is dict
            if good:
                for name, child in value.items():
                    _check(child, _at(location, name), budget)
        elif key in ("items", "additionalProperties", "not"):
            _check(value, location, budget)
        elif key in ("anyOf", "allOf", "oneOf"):
            good = type(value) is list and bool(value)
            if good:
                for index, child in enumerate(value):
                    _check(child, _at(location, index), budget)
        elif key == "required":
            good = type(value) is list and all(type(n) is str for n in value)
            good = good and len(set(value)) == len(value)
        elif key == "enum":
            good = type(value) is list and bool(value)
            if good:
                good = not any(_equal(v, value[j], budget) for i, v in enumerate(value) for j in range(i))
        elif key in ("const", "default"):
            pass
        elif key == "examples":
            good = type(value) is list
        elif key in _BOUNDS:
            good = _number(value) and (key != "multipleOf" or value > 0)
        elif key in _LENGTHS:
            good = _number(value) and value >= 0 and int(value) == value
        elif key in ("uniqueItems", "readOnly", "writeOnly", "deprecated"):
            good = type(value) is bool
        elif key in ("title", "description", "$comment"):
            good = type(value) is str
        elif key == "$schema":
            good = value == "https://json-schema.org/draft/2020-12/schema"
        else:
            raise SchemaConfigurationError(f"{location}: unsupported schema keyword {key!r}")
        if not good:
            raise SchemaConfigurationError(f"{location}: invalid keyword value")


def _matches(name, value):
    if name == "null":
        return value is None
    if name == "number":
        return _number(value)
    if name == "integer":
        return _number(value) and int(value) == value
    return type(value) is {"boolean": bool, "object": dict, "array": list, "string": str}[name]


def _validate(schema, value, sp, ip, budget):
    budget.visit()

    def bad(key, message):
        raise SchemaValidationError(message, instance_path=ip, schema_path=_at(sp, key) if key else sp)

    if type(schema) is bool:
        if not schema:
            bad("", "Value prohibited by false schema")
        return
    if "type" in schema:
        names = schema["type"] if type(schema["type"]) is list else [schema["type"]]
        if not any(_matches(name, value) for name in names):
            bad("type", "Value does not match allowed type")
    if "const" in schema and not _equal(value, schema["const"], budget):
        bad("const", "Value differs from const")
    if "enum" in schema and not any(_equal(value, item, budget) for item in schema["enum"]):
        bad("enum", "Value is not in enum")
    for key in ("anyOf", "allOf", "oneOf", "not"):
        if key not in schema:
            continue
        branches = [schema[key]] if key == "not" else schema[key]
        passed = 0
        for index, branch in enumerate(branches):
            try:
                _validate(branch, value, _at(sp, key) if key == "not" else _at(_at(sp, key), index), ip, budget)
                passed += 1
            except SchemaValidationError:
                pass
        if ((key == "anyOf" and not passed) or (key == "allOf" and passed != len(branches))
                or (key == "oneOf" and passed != 1) or (key == "not" and passed)):
            bad(key, f"Value does not satisfy {key}")
    if _number(value):
        number = _decimal(value)
        for key in _BOUNDS & schema.keys():
            bound = _decimal(schema[key])
            valid = {"minimum": lambda: number >= bound, "maximum": lambda: number <= bound,
                     "exclusiveMinimum": lambda: number > bound, "exclusiveMaximum": lambda: number < bound,
                     "multipleOf": lambda: (number / bound).denominator == 1}[key]()
            if not valid:
                bad(key, f"Numeric constraint {key} violated")
    if type(value) in (str, dict, list):
        suffix = {str: "Length", dict: "Properties", list: "Items"}[type(value)]
        for prefix, violated in (("min", lambda n: len(value) < n), ("max", lambda n: len(value) > n)):
            key = prefix + suffix
            if key in schema and violated(schema[key]):
                bad(key, f"Size constraint {key} violated")
    if type(value) is dict:
        for name in schema.get("required", []):
            if name not in value:
                bad("required", f"Missing property: {name}")
        properties = schema.get("properties", {})
        for name, child in value.items():
            if name in properties:
                _validate(properties[name], child, _at(_at(sp, "properties"), name), _at(ip, name), budget)
            elif "additionalProperties" in schema:
                _validate(schema["additionalProperties"], child, _at(sp, "additionalProperties"), _at(ip, name), budget)
    if type(value) is list:
        if schema.get("uniqueItems", False):
            if any(_equal(child, value[j], budget) for i, child in enumerate(value) for j in range(i)):
                bad("uniqueItems", "Duplicate array item")
        if "items" in schema:
            for index, child in enumerate(value):
                _validate(schema["items"], child, _at(sp, "items"), _at(ip, index), budget)


def _inline_generated_refs(root):
    """Expand only Pydantic-generated local refs; reject cycles and remote refs."""
    budget = _Budget()

    def expand(node, active=(), depth=0):
        budget.visit()
        if depth > 128:
            raise SchemaConfigurationError("Expanded schema nesting exceeds 128")
        if type(node) is bool:
            return node
        result = {}
        if "$ref" in node:
            ref = node["$ref"]
            if not isinstance(ref, str) or not ref.startswith("#/$defs/") or ref in active:
                raise SchemaConfigurationError("Recursive or nonlocal Pydantic schema references are unsupported")
            target = root
            try:
                for part in ref[2:].split("/"):
                    target = target[part.replace("~1", "/").replace("~0", "~")]
            except (KeyError, TypeError) as error:
                raise SchemaConfigurationError("Unresolved Pydantic schema reference") from error
            result = expand(target, (*active, ref), depth + 1)
        siblings = {}
        for key, value in node.items():
            if key in ("$ref", "$defs"):
                continue
            if key == "properties":
                value = {name: expand(child, active, depth + 1) for name, child in value.items()}
            elif key in ("items", "additionalProperties", "not"):
                value = expand(value, active, depth + 1)
            elif key in ("anyOf", "allOf", "oneOf"):
                value = [expand(child, active, depth + 1) for child in value]
            siblings[key] = value
        return {"allOf": [result, siblings]} if "$ref" in node and siblings else (result if "$ref" in node else siblings)

    # Check even unused definitions, rather than silently dropping constraints.
    for definition in root.get("$defs", {}).values():
        _check(expand(definition), "", _Budget())
    return expand(root)


class SchemaAdapter(Generic[T]):
    """Prepared schema. json_schema returns a defensive dict copy for transport."""

    def __init__(self, schema: dict, parser: Optional[Callable[[Any], T]] = None):
        self._schema = schema
        self._parser = parser

    @property
    def json_schema(self) -> dict:
        return json_snapshot(self._schema)

    def parse(self, value: Any) -> T:
        try:
            copied = json_snapshot(value)
        except TypeError as error:
            raise SchemaValidationError(str(error)) from error
        if self._parser is not None:
            return self._parser(copied)
        _validate(self._schema, copied, "", "", _Budget())
        return copied


def normalize_schema(schema: Any) -> SchemaAdapter:
    """Validate configuration now; optional Pydantic is imported only for classes."""
    if isinstance(schema, SchemaAdapter):
        return schema
    parser = None
    if type(schema) not in (dict, bool):
        if not isinstance(schema, type):
            raise SchemaConfigurationError("Expected JSON Schema or a Pydantic v2 BaseModel/dataclass class")
        try:
            import pydantic
            from pydantic import TypeAdapter
        except ImportError as error:
            raise SchemaConfigurationError("Pydantic v2 must be installed by the application for class schemas") from error
        if not str(pydantic.__version__).startswith("2."):
            raise SchemaConfigurationError("Class schemas require Pydantic v2")
        if not (issubclass(schema, pydantic.BaseModel) or is_dataclass(schema)):
            raise SchemaConfigurationError("Expected a Pydantic BaseModel or dataclass class")
        try:
            adapter = TypeAdapter(schema)
            schema = _inline_generated_refs(json_snapshot(adapter.json_schema(mode="validation")))
        except SchemaConfigurationError:
            raise
        except Exception as error:
            raise SchemaConfigurationError(f"Cannot convert Pydantic schema: {error}") from error

        def parser(value):
            try:
                return adapter.validate_python(value)
            except pydantic.ValidationError as error:
                raise SchemaValidationError(str(error)) from error
    try:
        copied = json_snapshot(schema)
        _check(copied, "", _Budget())
    except (TypeError, SchemaResourceError) as error:
        raise SchemaConfigurationError(str(error)) from error
    # The public model-facing shape stays a dictionary even for boolean schemas.
    if type(copied) is bool:
        copied = {} if copied else {"not": {}}
    return SchemaAdapter(copied, parser)
