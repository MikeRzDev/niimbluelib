// Command gensrc writes the go/zz_*.c wrappers that compile the C sources
// into the Go package. Each wrapper embeds a SHA-256 of the sources it pulls
// in: the Go build cache does not track files #included from outside the
// package directory, so without the hash a C change would not trigger a
// rebuild. Run `go generate ./go` after changing anything in src/, include/,
// generated/ or third_party/quickjs/ (TestCSourcesInSync checks it).
package main

import (
	"fmt"
	"os"
	"path/filepath"

	"github.com/MultiMote/niimbluelib/native/go/internal/srchash"
)

func main() {
	goDir := "."
	if len(os.Args) > 1 {
		goDir = os.Args[1]
	}
	root := filepath.Join(goDir, "..")
	for _, w := range srchash.Wrappers {
		h, err := srchash.Hash(root, w.Deps)
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		if err := os.WriteFile(filepath.Join(goDir, w.Name), []byte(srchash.Render(w, h)), 0o644); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
	}
}
