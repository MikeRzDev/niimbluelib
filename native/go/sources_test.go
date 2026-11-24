package niimblue

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/MultiMote/niimbluelib/native/go/internal/srchash"
)

// The cgo wrappers embed a hash of the C sources so the Go build cache
// rebuilds them after C changes. Fails when `go generate ./go` is needed.
func TestCSourcesInSync(t *testing.T) {
	for _, w := range srchash.Wrappers {
		h, err := srchash.Hash("..", w.Deps)
		if err != nil {
			t.Fatal(err)
		}
		got, err := os.ReadFile(filepath.Join(".", w.Name))
		if err != nil {
			t.Fatal(err)
		}
		if string(got) != srchash.Render(w, h) {
			t.Errorf("%s is out of date with the C sources: run `go generate ./go` and rebuild", w.Name)
		}
	}
}
