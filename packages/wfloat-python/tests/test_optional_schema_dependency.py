"""The plain JSON Schema path must work when Pydantic is not installed."""
import os
from pathlib import Path
import subprocess
import sys


def test_plain_schema_does_not_import_pydantic():
    code = '''
import importlib.abc
import sys
class RejectPydantic(importlib.abc.MetaPathFinder):
    def find_spec(self, fullname, path=None, target=None):
        if fullname == "pydantic" or fullname.startswith("pydantic."):
            raise AssertionError("plain schemas imported optional Pydantic")
sys.meta_path.insert(0, RejectPydantic())
from wfloat._schemas import normalize_schema
schema = normalize_schema({"type": "object", "properties": {"city": {"type": "string"}}, "required": ["city"]})
assert schema.parse({"city": "Boston"}) == {"city": "Boston"}
assert not any(n == "pydantic" or n.startswith("pydantic.") for n in sys.modules)
'''
    env = dict(os.environ)
    env['PYTHONPATH'] = str(Path(__file__).parents[1] / 'python')
    subprocess.run([sys.executable, '-c', code], env=env, check=True, capture_output=True, text=True)
