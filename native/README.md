# niimbluelib-native

[niimbluelib](..) (the NIIMBOT printer library, TypeScript) compiled into a
**self-contained native library** with a plain C API, plus **Go**, **Rust**, **Kotlin / Java**
(desktop JVM and Android, through JNI), **Swift** (macOS, iOS) and **Python** bindings.

```
 your Go / Rust / C program
          │  C API (include/niimblue.h)
 ┌────────▼──────────────────────────────────────────┐
 │ libniimblue (.a / .so / .dylib / .dll)            │
 │  worker thread + event loop (src/niimblue.c)      │
 │  QuickJS-ng engine  (third_party/quickjs)         │
 │  niimbluelib bundle (generated/niim_bundle.c)     │
 │  transports: serial (built-in) | custom | virtual │
 └───────────────────────────────────────────────────┘
```

No Node.js at runtime and no extra files: the JS is compiled into the binary.
Bluetooth LE isn't built in. Implement it in the host language (the Go example uses
`tinygo.org/x/bluetooth`) and plug it in with the custom transport.

## Layout

| Path | What |
|---|---|
| `include/niimblue.h` | The C API (documented) |
| `src/` | C core: event loop, timers, JS glue, serial port (POSIX + Win32) |
| `js/` | JS bridge bundled with niimbluelib (`npm run bundle`) |
| `api/` | `api.json` (method spec) + `generate.mjs`: generates the typed methods of every binding |
| `generated/niim_bundle.c` | Pre-built bundle (committed, so C builds need no Node) |
| `third_party/quickjs/` | Vendored QuickJS-ng v0.18.0 engine sources |
| `go/` | Go package `niimblue` (cgo compiles everything, no CMake needed) + **test suite** |
| `examples/go/niimprint/` | Go CLI: BLE / serial printing, text rendering, hardware test |
| `bindings/rust/` | Rust crate `niimblue` (static build via CMake) |
| `bindings/jni/` | JNI layer (C) shared by the desktop JVM and Android |
| `bindings/kotlin/` | Gradle build: Kotlin Multiplatform library `io.github.multimote:niimblue` (jvm + android) |
| `bindings/python/`, `pyproject.toml` | Python package `niimblue` (ctypes; the wheel carries the shared library) |
| `bindings/swift/`, `../Package.swift` | Swift package `Niimblue` (SwiftPM compiles the C sources; manifest at the repo root) |
| `cmake/` | CMake package config and pkg-config templates |
| `test/`, `examples/c/` | C test program and C CLI |

## Using it as a dependency

Everything builds from source (no registry releases yet): C and every binding compile the
library with CMake + a C compiler, except Go (cgo compiles it). Paths below are relative to
the `niimbluelib` checkout. Every binding runs the same checks against a virtual B1 printer
(`go/testdata`): render / print the asset tag template, UTF-8 round trip, callbacks on the
library thread, reentrancy, swapping event handlers while events fire, parallel handles.

| Language | Dependency | Tests |
|---|---|---|
| C / C++ | `find_package(niimblue)`, `add_subdirectory`, pkg-config | `./build/niim_test` |
| Rust | `niimblue = { path = "native/bindings/rust" }` | `cargo test` in `bindings/rust` |
| Go | `replace github.com/MultiMote/niimbluelib/native => ./native` | `go test -race ./go/` |
| Kotlin / Java | `includeBuild("native/bindings/kotlin")` + `io.github.multimote:niimblue:0.1.0` | `./gradlew :niimblue:jvmTest` / `:niimblue:connectedAndroidDeviceTest` |
| Swift | `.package(url: <repo>, branch:)` or `.package(path: "../niimbluelib")`, product `Niimblue` | `swift test` (repo root), `xcodebuild test -scheme Niimblue -destination 'platform=iOS Simulator,name=iPhone 17 Pro'` |
| Python | `pip install ./native` | `python -m unittest discover -s bindings/python/tests` |

## Print queue

Every print (`niim_print`, `niim_print_batch`, `niim_print_template`) is a job in a FIFO queue
and one job prints at a time. niimbluelib only serializes single packets, so without the queue
two overlapping prints would interleave their packets and both fail; now concurrent callers
wait for their turn.

- **Multi page jobs:** `niim_print_batch` prints several different images in one print task,
  each page with its own quantity (and optional format / stride / threshold / printDirection).
  Sizes are validated when the job is submitted, pages are encoded when it runs.
- **Blocking or not:** print calls wait for their job by default (result + `jobId`);
  `{"wait":false}` returns the job snapshot at once (`Submit` in Go, `submit` elsewhere).
- **Management** through `niim_call`: `getJob`, `listJobs`, `cancelJob` (queued jobs only),
  `clearQueue`, `waitJob`, `pauseQueue` / `resumeQueue` (the printing job finishes, nothing new starts).
- **Connection loss:** disconnect, reconnect or the device closing the link fail the queued
  jobs with "disconnected"; the printing job fails on its own.
- **Events:** `jobqueued`, `jobstarted`, `jobdone`; `printprogress`, `printpacketprogress` and
  `printend` carry the `jobId` of the printing job.

Details in [`include/niimblue.h`](include/niimblue.h) ("Print queue").

```go
res, err := p.PrintBatch([]niimblue.Page{
    {Image: label1, Quantity: 2},
    {Image: label2},
}, &niimblue.PrintOptions{Label: "shelf A"})

job, err := p.Submit(pages, nil)   // returns at once
done, err := p.WaitJob(job.ID)     // done.PrintResult()
```

## PNG printer (test print)

`niim_connect_png` (Go `ConnectPNG`) connects to a simulated printer that writes PNG files
instead of burning labels. It is the test print, and it is the real print path end to end:
jobs printed to it go through the same queue, print task and packets as on a real printer.
The printer side decodes the image packets into the dots the head would burn and lays them on
the label like the device: centered across the print head, cut at the head and label edges,
fed in the model's direction. The PNG is the final tag in reading orientation, so a wrong
`printDirection`, label size or printhead width shows up rotated / cut off exactly like on paper.

```go
sim, _ := niimblue.New()
sim.ConnectPNG(&niimblue.PNGPrinterOptions{Model: "B1"}) // LabelWidth/Height, PrintheadPixels: optional
res, err := sim.PrintTemplate(tmpl, rows, nil)
pages, _ := sim.PNGPages(res.JobID)                       // one PNG per label: pages[0].PNG
```

Other bindings: `connect_png` / `png_pages` (`niim_call` `pngPages {"jobId"}` returns base64 PNGs).
Two-color and grayscale pages are not supported by the PNG printer yet.

The Go tests use it to check what reaches the paper (page content, order, copies, rotation,
cuts). Save the printed tags to look at them:

```sh
NIIM_PNG_DIR=/tmp/niim-tags go test ./go/ -run PNGPrinter -v
```

## Template packages (.niim)

Templates are `.niim` files only: a ZIP with `template.json` plus `images/` and `fonts/`, as
exported from the NiimBlue editor. `renderTemplate`, `printTemplate` and `templateTags` take the
package bytes in every binding (C: `niim_render_template(h, package, package_len, ...)`);
template JSON is rejected. Embedded TTF / OTF fonts are registered when the template is rendered
(WOFF / WOFF2 fall back to the default font). Go also converts JPEG / GIF / interlaced PNG images
in the package to plain PNG.

```go
tmpl, _ := os.ReadFile("asset-tag.niim")
res, err := p.PrintTemplate(tmpl, rows, nil)
```

## Go

```go
import niimblue "github.com/MultiMote/niimbluelib/native/go"

p, _ := niimblue.New()
defer p.Close()
info, err := p.ConnectSerial("/dev/ttyACM0", nil)   // or ConnectCustom(write, nil) for BLE
res, err := p.Print(img, &niimblue.PrintOptions{Quantity: 1})
```

Tests (virtual printer, PNG printer, fake printer over a custom transport and over a real
pseudo-terminal, print queue, concurrency, reconnects, error paths):

```sh
go test ./go/ -race
```

Print on real hardware (Go example module):

```sh
cd examples/go/niimprint
go run . -scan                                    # list BLE devices
go run . -ble B1 -text "Hello World"              # print over Bluetooth LE
NIIM_HW_BLE=B1 go test -run TestHardwareHelloWorld -v
NIIM_HW_PORT=/dev/ttyACM0 go test -run TestHardwareHelloWorld -v
```

**After changing C sources** (`src/`, `include/`, `generated/`, `third_party/quickjs/`) run
`go generate ./go`. The Go build cache doesn't track files `#include`d from outside the package,
so the `go/zz_*.c` wrappers carry a hash of their sources. `TestCSourcesInSync` fails if you forget.

The module path `github.com/MultiMote/niimbluelib/native` is a placeholder until the repo is
hosted, so `go get` can't fetch it yet. Use it from another module with a `replace` directive:

```
require github.com/MultiMote/niimbluelib/native v0.0.0
replace github.com/MultiMote/niimbluelib/native => ../niimbluelib/native
```

Once hosted, change the module path in `go.mod` (and the imports) to the repo path plus `/native`.

## Rust

```toml
[dependencies]
niimblue = { path = "../niimbluelib/native/bindings/rust" }
# once hosted: niimblue = { git = "<repo url>", branch = "..." }  (cargo finds the crate in the repo)
```

```rust
let p = niimblue::Printer::new()?;
p.connect_serial("/dev/ttyACM0", None)?;
p.print(&pixels, w, h, Some(r#"{"format":"gray"}"#))?;
p.print_template(&std::fs::read("label.niim")?, Some(r#"{"uuid":"..."}"#), None)?;
```

`build.rs` builds the static library with CMake (needs `cmake` + a C compiler), so the final
binary is self-contained. `cargo test`, `cargo run --example info -- [port]`.

## Kotlin / Java (desktop JVM and Android)

One Kotlin API (`bindings/kotlin/niimblue/src/jniMain`) over one JNI layer
(`bindings/jni/niimblue_jni.c`); only loading the native library differs per platform:

- **Desktop JVM**: the build compiles `libniimblue_jni` for the machine running Gradle with
  CMake and packs it into the jar under `natives/<os>-<arch>/`; at runtime it's extracted once
  to the temp directory. Add libraries built on other machines to `niimblue/prebuilt/natives/`
  to ship one jar for several platforms. `-Dniimblue.library.path=/path/to/lib` overrides.
- **Android**: `:niimblue-android-native` (a `com.android.library` module: the KMP Android
  plugin can't build native code) compiles `libniimblue_jni.so` with the NDK for arm64-v8a,
  armeabi-v7a, x86_64 and x86 (16 KB page aligned). R8 keep rules ship with the AAR.

Use it from another Gradle build (KMP, Android or plain JVM / Java):

```kotlin
// settings.gradle.kts
includeBuild("../niimbluelib/native/bindings/kotlin")

// build.gradle.kts (or commonMain / androidMain / jvmMain dependencies in KMP)
dependencies { implementation("io.github.multimote:niimblue:0.1.0") }
```

```kotlin
NiimPrinter().use { p ->
    p.setEventListener { name, json -> println("$name $json") }
    p.connectSerial("/dev/ttyACM0")             // or connectCustom(transport) for Bluetooth LE
    p.printTemplate(File("label.niim").readBytes(), """{"uuid":"..."}""")
}
```

Options, data and results are JSON strings; failures throw `NiimException` (`code`). Java
works the same (`try (NiimPrinter p = new NiimPrinter()) { ... }`, see `examples-java`).
`./gradlew publishToMavenLocal` publishes `io.github.multimote:niimblue` (+ `-jvm`, `-android`) and
`io.github.multimote:niimblue-android-native` for builds that prefer `mavenLocal()`. The library is
compiled for Kotlin 2.0 metadata, so consumers on Kotlin 1.9+ can use it.

Needs JDK 17+, CMake and, for Android, the SDK with NDK 28.2.13676358.

```sh
cd bindings/kotlin
./gradlew :niimblue:jvmTest                          # desktop tests (run with -Xcheck:jni)
./gradlew :niimblue:connectedAndroidDeviceTest       # same tests on a device / emulator
./gradlew :examples-java:run
```

## Swift (macOS, iOS)

SwiftPM compiles the C library itself (`bindings/swift/Sources/CNiimblue` only `#include`s
`src/`, `generated/` and `third_party/quickjs/`), so there's no separate build step. The API
is plain Swift (`bindings/swift/Sources/Niimblue`); Bluetooth LE comes from CoreBluetooth in
the app through `connectCustom`.

```swift
// Package.swift
.package(url: "https://github.com/MultiMote/niimbluelib.git", branch: "main"),  // or .package(path: "../niimbluelib")
.target(name: "App", dependencies: [.product(name: "Niimblue", package: "niimbluelib")]),
```

```swift
import Niimblue

let printer = try NiimPrinter()                      // freed on release, or printer.close()
printer.onEvent { name, json in print(name, json) }
try printer.connectCustom { data in sendToPrinter(data) }   // e.g. CBPeripheral.writeValue, return success
// peripheral(_:didUpdateValueFor:) -> try printer.feed(value)
let niim = try Data(contentsOf: labelURL)                       // .niim package
try printer.printTemplate(niim, data: #"{"uuid":"..."}"#)
let label = try printer.renderTemplateRGBA(niim, data: dataJSON)   // width, height, RGBA Data
```

Calls block, so make them off the main thread. The manifest is `Package.swift` at the
repository root (SwiftPM only reads it there), so the package works by git URL and as a local
package: in Xcode, add the `niimbluelib` folder or URL. Tests: `swift test` in the repo root.
Debug builds run QuickJS unoptimized (rendering is several times slower than in release builds).

## Python

```sh
pip install ../niimbluelib/native                  # builds the shared library into the wheel
```

```python
import niimblue

with niimblue.Printer() as p:
    p.connect_serial("/dev/ttyACM0")
    niim = open("label.niim", "rb").read()      # .niim package
    p.print_template(niim, {"uuid": "..."})     # data / options: dicts / lists, or JSON strings
    label = p.render_template_rgba(niim, data)  # width, height, print_direction, RGBA bytes
```

ctypes over the C API, no Python C extension: one wheel per platform for every Python 3.
See `bindings/python/README.md`.

## C

```sh
cmake -B build && cmake --build build
./build/niim_test                          # C tests
./build/niim_cli print /dev/ttyACM0 label.pgm '{"quantity":1}'
cmake --install build --prefix /usr/local  # header, libraries, CMake package, pkg-config
```

Outputs `libniimblue.a` (static, self-contained) and `libniimblue.{so,dylib}` / `niimblue.dll`.
Symbols other than `niim_*` are hidden.

From another CMake project, after installing (`-DCMAKE_PREFIX_PATH=<prefix>`) or straight from
the source tree:

```cmake
find_package(niimblue 0.1 CONFIG REQUIRED)       # or: add_subdirectory(../niimbluelib/native niimblue)
target_link_libraries(app PRIVATE niimblue::niimblue)   # shared; niimblue::static for static linking
```

As a subproject the C tests and install rules are off by default (`NIIM_BUILD_TESTS`,
`NIIM_INSTALL`). Without CMake: `cc app.c $(pkg-config --cflags --libs niimblue)`.

## Adding a method (generated bindings)

Each binding is a small hand-written core plus generated code; a new library method needs no
C, JNI or binding code:

1. Add it to `methods` in `js/bridge.ts`.
2. Describe it in `api/api.json` (format in its `$comment`): JS method, API name, doc, `const`
   params, params (`int`, `bool`, `string`, `json`, `bytes`, `<Record>[]`; `?` = optional) and
   result (`void`, `bool`, `int`, `string`, `json`, a type or `Type[]`). New records / Go result
   structs go in `types`.
3. `npm run typecheck && npm run gen && npm run bundle && go generate ./go`

What is generated (`npm run gen`, deterministic, Go via gofmt):

| From | Output |
|---|---|
| `api/api.json` | methods + records: `go/zz_api.go`, `go/zz_api_types.go`, `bindings/rust/src/api.rs`, `bindings/python/niimblue/_api.py`, `bindings/swift/Sources/Niimblue/NiimPrinter+API.swift`, `bindings/kotlin/.../NiimPrinterApi.kt`; the method list in `include/niimblue.h` |
| `include/niimblue.h` | FFI declarations: `bindings/rust/src/sys.rs`, `bindings/python/niimblue/_ffi.py` (Go and Swift import the header) |

Every generated method goes through `niim_call_bin` (`niim_call` with an optional binary payload;
`connect` through it handles the JS-only transports). `npm run gen:check` fails when a generated
file is stale or `js/bridge.ts` has a method `api.json` doesn't list; `go test` runs it too.

Hand-written, per binding, only what C can't describe: the handle lifetime (`close` waits for
running calls), the event and custom-transport callbacks (trampolines, a callback pointer kept for
the handle's lifetime), error mapping, serial / custom connect, and native conveniences (Go
`image.Image` printing and templates, Python / Swift `render_template_rgba`, Swift `pngPages`).
It only changes when the C ABI does. JNI (`bindings/jni`) is part of that core: it registers 13
natives that wrap the C core functions.

Naming: Go `PascalCase` (a lowercase `names.go` keeps a method unexported for a hand-written
wrapper), Rust / Python `snake_case`, Swift / Kotlin `camelCase`. Results: Go decodes into the
typed result; Rust, Swift and Kotlin return `bool` / `int` natively and JSON text otherwise;
Python returns parsed JSON (base64 `bytes` fields of spec types decoded). `skip` keeps a
hand-written version for one language.

## Updating niimbluelib

```sh
npm install
node js/build.mjs --niimbluelib ..                    # regenerates generated/niim_bundle.c
node test/gen_print_dump.mjs --niimbluelib ..
go generate ./go && go test ./go/
```

Bundle from a clean checkout or `git archive` export if the niimbluelib working tree has
unfinished changes.

## Notes

- The B1 shows up on macOS as `/dev/cu.B1-…` (Bluetooth Classic serial), but it doesn't answer
  the NIIMBOT protocol there. Use Bluetooth LE (as niimblue in the browser does) or USB.
- Windows code paths (Win32 threads, overlapped serial I/O) are written but not yet tested on Windows.
