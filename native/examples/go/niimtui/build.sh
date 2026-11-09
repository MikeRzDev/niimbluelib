#!/usr/bin/env bash
# Builds niimtui into ./build, after go vet and the tests.
#
#   ./build.sh                 vet, test, build for this machine -> build/niimtui
#   ./build.sh --no-test       build without vet and tests
#   ./build.sh --test          vet and test only, no build
#   ./build.sh --clean         remove build/ and exit
#   GOOS=linux GOARCH=arm64 CC=aarch64-linux-gnu-gcc ./build.sh
#                              cross-compile (needs a C cross compiler, see below);
#                              output is build/niimtui-linux-arm64. The tests run
#                              on this machine first, the binary is not run.
#
# The tests open the .niim templates in testdata, test print them through the
# PNG printer and print on the virtual B1 (no printer needed).
#
# niimtui links the niimblue C library (QuickJS + niimbluelib) through cgo, so
# a C compiler is required: Xcode Command Line Tools on macOS, gcc/clang on Linux.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"

BIN=niimtui
OUT_DIR=build
run_tests=1
build=1

for arg in "$@"; do
  case "$arg" in
    --no-test) run_tests=0 ;;
    --test) build=0 ;;
    --check) ;; # tests run by default now; kept for old invocations
    --clean) rm -rf "$OUT_DIR"; echo "removed $OUT_DIR/"; exit 0 ;;
    -h|--help) sed -n '2,17p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "build.sh: unknown option: $arg" >&2; exit 2 ;;
  esac
done

command -v go >/dev/null || { echo "build.sh: go is not installed or not on PATH" >&2; exit 1; }

# Name the binary after the target only when cross-compiling, so a plain
# local build stays a predictable build/niimtui.
host_os=$(go env GOHOSTOS)
host_arch=$(go env GOHOSTARCH)
target_os=${GOOS:-$host_os}
target_arch=${GOARCH:-$host_arch}
out=$BIN
if [ "$target_os" != "$host_os" ] || [ "$target_arch" != "$host_arch" ]; then
  out=$BIN-$target_os-$target_arch
  if [ -z "${CC:-}" ]; then
    echo "build.sh: cross-compiling to $target_os/$target_arch needs cgo: set CC to a C cross compiler" >&2
    echo "          (e.g. CC=aarch64-linux-gnu-gcc, or CC=\"zig cc -target aarch64-linux-gnu\")" >&2
    exit 1
  fi
fi
[ "$target_os" = windows ] && out=$out.exe

export CGO_ENABLED=1
cc=${CC:-$(go env CC)}
command -v "${cc%% *}" >/dev/null || {
  echo "build.sh: C compiler '$cc' not found (macOS: xcode-select --install)" >&2
  exit 1
}

if [ "$build" -eq 0 ] && [ "$run_tests" -eq 0 ]; then
  echo "build.sh: --test and --no-test leave nothing to do" >&2
  exit 2
fi

if [ "$run_tests" -eq 1 ]; then
  # vet and tests always run for this machine, also when cross-compiling
  echo "==> go vet"
  env -u GOOS -u GOARCH -u CC go vet ./...
  echo "==> go test"
  env -u GOOS -u GOARCH -u CC go test -count=1 ./...
fi

[ "$build" -eq 1 ] || exit 0

echo "==> building $OUT_DIR/$out ($target_os/$target_arch)"
mkdir -p "$OUT_DIR"
go build -trimpath -ldflags="-s -w" -o "$OUT_DIR/$out" .

echo "built $OUT_DIR/$out"
