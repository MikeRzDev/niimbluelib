# niimblue (Python)

NIIMBOT label printers from Python. [niimbluelib](../../..) and a QuickJS engine are
compiled into a native library (`libniimblue`); this package calls it through `ctypes`.
No Node.js and no Python C extension: one wheel per platform works on every Python 3.

```sh
pip install path/to/niimbluelib/native        # builds the library: needs CMake + a C compiler
```

```python
import niimblue

with niimblue.Printer() as p:
    p.on_event(lambda name, payload: print(name, payload))
    info = p.connect_serial("/dev/ttyACM0")          # or connect_custom(write) for Bluetooth LE
    p.print_template(open("label.niim", "rb").read(), {"uuid": "..."})
    label = p.render_template_rgba(template, data)   # RenderedLabel(width, height, ..., pixels)
```

Options, data and results are dicts (JSON strings are accepted too), see
[`include/niimblue.h`](../../include/niimblue.h). Errors raise `niimblue.NiimError` (`.code`).
`NIIMBLUE_LIBRARY=/path/to/libniimblue.dylib` overrides the bundled library.

Tests: `python -m unittest discover -s bindings/python/tests` (after installing).
