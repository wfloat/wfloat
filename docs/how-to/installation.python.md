# Install Wfloat

Use Python 3.9 or newer:

```sh
python -m pip install wfloat
```

Platform wheels bundle the native runtime; NumPy is installed as a dependency. If pip cannot find a wheel for your platform, a source installation requires a native build.

Optional Pydantic and dataclass schemas:

```sh
python -m pip install 'wfloat[schemas]'
```

The API is synchronous. Microphone capture and audio playback belong to your application.

**Next: [choose a model](https://wfloat.com/models)** and follow its Python example. See [model management](../reference/model-management.python.md) for caching and cleanup.
