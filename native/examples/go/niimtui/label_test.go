package main

import (
	"archive/zip"
	"bytes"
	"image/png"
	"os"
	"path/filepath"
	"strings"
	"testing"

	niimblue "github.com/MultiMote/niimbluelib/native/go"
)

// 30x20 mm asset tag exported from the NiimBlue editor: QR code {uuid}, three
// text fields and images.
const assetTag = "testdata/label_1794197090.niim"

func newPrinter(t *testing.T) *niimblue.Printer {
	t.Helper()
	p, err := niimblue.New()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { p.Close() })
	return p
}

// load runs loadTemplateCmd synchronously.
func load(t *testing.T, p *niimblue.Printer, path string) templateLoadedMsg {
	t.Helper()
	msg, ok := loadTemplateCmd(p, path)().(templateLoadedMsg)
	if !ok {
		t.Fatalf("loadTemplateCmd returned %T", msg)
	}
	return msg
}

func writeZip(t *testing.T, path string, files map[string]string) {
	t.Helper()
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	for name, data := range files {
		w, err := zw.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := w.Write([]byte(data)); err != nil {
			t.Fatal(err)
		}
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, buf.Bytes(), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestLoadTemplate(t *testing.T) {
	p := newPrinter(t)
	msg := load(t, p, assetTag)
	if msg.err != nil {
		t.Fatal(msg.err)
	}
	if !niimblue.IsTemplatePackage(msg.data) {
		t.Error("loaded data is not the package")
	}
	want := labelInfo{width: 240, height: 160, dpmm: 8, direction: "top"}
	if msg.info != want {
		t.Errorf("info = %+v, want %+v", msg.info, want)
	}

	var names []string
	for _, f := range msg.fields {
		names = append(names, f.name)
		if !f.required {
			t.Errorf("field %s not required", f.name)
		}
	}
	if got := strings.Join(names, ","); got != "uuid,asset_name,asset_type,site" {
		t.Errorf("fields = %s", got)
	}
	// UUID fields start with a fresh value, others empty
	if v := msg.fields[0].input.Value(); len(v) != 36 {
		t.Errorf("uuid field = %q, want a generated UUID", v)
	}
	if v := msg.fields[1].input.Value(); v != "" {
		t.Errorf("asset_name field = %q, want empty", v)
	}
}

func TestLoadTemplateRejectsNonPackages(t *testing.T) {
	p := newPrinter(t)
	dir := t.TempDir()

	jsonPath := filepath.Join(dir, "label.niim.json")
	if err := os.WriteFile(jsonPath, []byte(`{"format":"niimblue-template","version":1,
		"label":{"width":240,"height":160,"printDirection":"top"},"elements":[]}`), 0o644); err != nil {
		t.Fatal(err)
	}
	noTemplate := filepath.Join(dir, "empty.niim")
	writeZip(t, noTemplate, map[string]string{"readme.txt": "x"})
	badJSON := filepath.Join(dir, "bad.niim")
	writeZip(t, badJSON, map[string]string{"template.json": "{oops"})

	for path, want := range map[string]string{
		jsonPath:                        "not a .niim template package",
		noTemplate:                      "not a .niim template package",
		badJSON:                         "not a template",
		filepath.Join(dir, "none.niim"): "no such file",
	} {
		msg := load(t, p, path)
		if msg.err == nil || !strings.Contains(msg.err.Error(), want) {
			t.Errorf("%s: err = %v, want %q", filepath.Base(path), msg.err, want)
		}
	}
}

func TestTestPrint(t *testing.T) {
	p := newPrinter(t)
	tmpl := load(t, p, assetTag)
	if tmpl.err != nil {
		t.Fatal(tmpl.err)
	}
	data := map[string]string{
		"uuid": "794ad7ca-1ae2-451e-b06a-d93fd303e9d9", "asset_name": "Oppenheimer",
		"asset_type": "Compute Node", "site": "Manhattan",
	}
	out := testPrintPath(t.TempDir(), assetTag)

	// No printer connected: simulates a B1
	msg, ok := testPrintCmd(p, tmpl.data, data, out)().(testPrintedMsg)
	if !ok || msg.err != nil {
		t.Fatalf("test print: %+v", msg)
	}
	f, err := os.Open(msg.path)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	img, err := png.Decode(f)
	if err != nil {
		t.Fatal(err)
	}
	if b := img.Bounds(); b.Dx() != msg.width || b.Dy() != msg.height || msg.width != 240 || msg.height != 160 {
		t.Errorf("tag %v, message %dx%d, want 240x160", b, msg.width, msg.height)
	}

	// A missing required field fails without writing anything
	delete(data, "site")
	msg = testPrintCmd(p, tmpl.data, data, out+".2.png")().(testPrintedMsg)
	if msg.err == nil || !strings.Contains(msg.err.Error(), "site") {
		t.Errorf("missing field: err = %v", msg.err)
	}
	if _, err := os.Stat(out + ".2.png"); !os.IsNotExist(err) {
		t.Error("failed test print wrote a file")
	}
}

func TestHelpers(t *testing.T) {
	if got := testPrintPath("/out", "/labels/asset-tag.niim"); got != filepath.Join("/out", "asset-tag-test.png") {
		t.Errorf("testPrintPath = %s", got)
	}
	for in, want := range map[string]int{"1": 1, " 12 ": 12, "100": 100} {
		if n, err := parseCopies(in); err != nil || n != want {
			t.Errorf("parseCopies(%q) = %d, %v", in, n, err)
		}
	}
	for _, in := range []string{"0", "101", "-1", "x", ""} {
		if _, err := parseCopies(in); err == nil {
			t.Errorf("parseCopies(%q) accepted", in)
		}
	}
	for name, want := range map[string]bool{"uuid": true, "asset_UUID": true, "Guid": true, "site": false} {
		if isUUIDField(name) != want {
			t.Errorf("isUUIDField(%q) != %v", name, want)
		}
	}
	if orientationShort("top") != "horizontal" || orientationShort("left") != "vertical" {
		t.Error("orientationShort")
	}

	fields := []field{{name: "a", input: newInput(field{})}, {name: "b", input: newInput(field{})}}
	fields[0].input.SetValue("x")
	if got := formData(fields); len(got) != 1 || got["a"] != "x" {
		t.Errorf("formData = %v, want only filled inputs", got)
	}
}
