# wfloat-core

`wfloat-core` is the native runtime package used by the Python `wfloat` SDK.

It bundles the platform-specific `wfloat-core` shared library and exposes a
small Python helper:

```python
import wfloat_core

library_path = wfloat_core.get_library_path()
```

End users should normally install `wfloat`; this package is published
separately so native runtime wheels can be built and released independently
from the pure Python SDK.
