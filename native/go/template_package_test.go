package niimblue

import (
	"archive/zip"
	"bytes"
	"io"
	"os"
	"sort"
	"strings"
	"testing"
)

// packJSON builds a .niim package with Go's zip writer (deflated entries, no
// mimetype entry), like a third-party tool would: template.json plus files.
func packJSON(t *testing.T, templateJSON []byte, files map[string][]byte) []byte {
	t.Helper()
	all := map[string][]byte{"template.json": templateJSON}
	for name, data := range files {
		all[name] = data
	}
	names := make([]string, 0, len(all))
	for name := range all {
		names = append(names, name)
	}
	sort.Strings(names)

	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	for _, name := range names {
		w, err := zw.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := w.Write(all[name]); err != nil {
			t.Fatal(err)
		}
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

// unzipFiles returns the files of a package.
func unzipFiles(t *testing.T, pkg []byte) map[string][]byte {
	t.Helper()
	zr, err := zip.NewReader(bytes.NewReader(pkg), int64(len(pkg)))
	if err != nil {
		t.Fatal(err)
	}
	out := map[string][]byte{}
	for _, f := range zr.File {
		rc, err := f.Open()
		if err != nil {
			t.Fatal(err)
		}
		b, err := io.ReadAll(rc)
		rc.Close()
		if err != nil {
			t.Fatal(err)
		}
		out[f.Name] = b
	}
	return out
}

func TestTemplatePackage(t *testing.T) {
	p := newPrinter(t)
	if !IsTemplatePackage(assetTag) {
		t.Fatal("asset tag fixture is not a package")
	}

	// The same files re-zipped by Go (deflate, no mimetype entry) render identically
	files := unzipFiles(t, assetTag)
	tmplJSON := files["template.json"]
	delete(files, "template.json")
	delete(files, "mimetype")
	rezipped := packJSON(t, tmplJSON, files)

	want, err := p.RenderTemplate(assetTag, assetData, nil)
	if err != nil {
		t.Fatal(err)
	}
	got, err := p.RenderTemplate(rezipped, assetData, nil)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got.Pix, want.Pix) {
		t.Error("re-zipped package renders differently")
	}

	// Template JSON is not accepted, only packages
	for name, call := range map[string]func() error{
		"RenderTemplate": func() error { _, err := p.RenderTemplate(tmplJSON, assetData, nil); return err },
		"PrintTemplate": func() error {
			_, err := p.PrintTemplate(tmplJSON, []map[string]string{assetData}, nil)
			return err
		},
		"TemplateTags": func() error { _, err := p.TemplateTags(tmplJSON); return err },
	} {
		if err := call(); err == nil || !strings.Contains(err.Error(), ".niim package") {
			t.Errorf("%s(template JSON): err = %v", name, err)
		}
	}

	// Bad packages fail with the library's message
	bad := packJSON(t, bytes.Replace(tmplJSON, []byte(`"src": "images/`), []byte(`"src": "../`), 1), files)
	if _, err := p.RenderTemplate(bad, assetData, nil); err == nil || !strings.Contains(err.Error(), "invalid path") {
		t.Errorf("path traversal: err = %v", err)
	}
	noTemplate := packJSON(t, nil, nil)
	noTemplate = bytes.Replace(noTemplate, []byte("template.json"), []byte("templatx.json"), -1)
	if _, err := p.RenderTemplate(noTemplate, nil, nil); err == nil || !strings.Contains(err.Error(), "template.json not found") {
		t.Errorf("no template.json: err = %v", err)
	}
}

func TestTemplatePackageFont(t *testing.T) {
	p := newPrinter(t)
	font, err := os.ReadFile("../third_party/fonts/NotoSans-Bold.ttf")
	if err != nil {
		t.Fatal(err)
	}
	template := func(withFont bool) []byte {
		fonts := ""
		if withFont {
			fonts = `,"fonts":[{"family":"Package Font","src":"fonts/package-font.ttf"}]`
		}
		j := `{"format":"niimblue-template","version":1,
			"label":{"width":240,"height":60,"printDirection":"top"},
			"elements":[{"type":"text","x":4,"y":4,"width":232,"text":"Embedded font",
				"font":{"family":"Package Font","size":32}}]` + fonts + `}`
		return packJSON(t, []byte(j), map[string][]byte{"fonts/package-font.ttf": font})
	}

	// Without the embedded font the unknown family falls back to the regular default font
	regular, err := p.RenderTemplate(template(false), nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	bold, err := p.RenderTemplate(template(true), nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	r, b := blackIn(regular, regular.Rect), blackIn(bold, bold.Rect)
	if b <= r*11/10 {
		t.Errorf("embedded bold font not used: %d black pixels vs %d with the default font", b, r)
	}
	fonts, err := p.Fonts()
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, f := range fonts {
		found = found || f.Family == "Package Font"
	}
	if !found {
		t.Errorf("embedded font not registered: %+v", fonts)
	}
}
