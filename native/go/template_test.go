package niimblue

import (
	"bytes"
	_ "embed"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"image"
	"image/color"
	"image/jpeg"
	"image/png"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// 30x20 mm asset tag from the NiimBlue editor: logo (PNG), title, QR code {uuid}
// and three shrink-to-fit text fields.
//
//go:embed testdata/asset-tag.niim
var assetTag []byte

var updateGolden = flag.Bool("update", false, "rewrite testdata/*.golden.png")

var assetData = map[string]string{
	"uuid":       "794ad7ca-1ae2-451e-b06a-d93fd303e9d9",
	"asset_name": "Oppenheimer",
	"asset_type": "Compute Node",
	"site":       "Manhattan",
}

// blackIn counts black pixels inside r.
func blackIn(img *image.NRGBA, r image.Rectangle) int {
	n := 0
	r = r.Intersect(img.Rect)
	for y := r.Min.Y; y < r.Max.Y; y++ {
		for x := r.Min.X; x < r.Max.X; x++ {
			if img.NRGBAAt(x, y) == (color.NRGBA{0, 0, 0, 255}) {
				n++
			}
		}
	}
	return n
}

func checkGolden(t *testing.T, name string, img *image.NRGBA) {
	t.Helper()
	path := filepath.Join("testdata", name+".golden.png")
	if *updateGolden {
		var buf bytes.Buffer
		if err := png.Encode(&buf, img); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, buf.Bytes(), 0o644); err != nil {
			t.Fatal(err)
		}
		return
	}
	f, err := os.Open(path)
	if err != nil {
		t.Fatalf("%v (run go test -run %s -update to create it)", err, t.Name())
	}
	defer f.Close()
	want, err := png.Decode(f)
	if err != nil {
		t.Fatal(err)
	}
	if want.Bounds() != img.Bounds() {
		t.Fatalf("golden size %v, got %v", want.Bounds(), img.Bounds())
	}
	diff := 0
	for y := 0; y < img.Rect.Dy(); y++ {
		for x := 0; x < img.Rect.Dx(); x++ {
			r1, g1, b1, _ := want.At(x, y).RGBA()
			c := img.NRGBAAt(x, y)
			if uint8(r1>>8) != c.R || uint8(g1>>8) != c.G || uint8(b1>>8) != c.B {
				diff++
			}
		}
	}
	if diff > 0 {
		out := filepath.Join(t.TempDir(), name+".png")
		var buf bytes.Buffer
		_ = png.Encode(&buf, img)
		_ = os.WriteFile(out, buf.Bytes(), 0o644)
		t.Errorf("%d pixels differ from %s (got %s)", diff, path, out)
	}
}

func TestRenderTemplate(t *testing.T) {
	p := newPrinter(t)
	recordEvents(t, p)

	img, err := p.RenderTemplate(assetTag, assetData, nil)
	if err != nil {
		t.Fatal(err)
	}
	if img.Rect.Dx() != 240 || img.Rect.Dy() != 160 {
		t.Fatalf("size %v", img.Rect)
	}

	// Only pure black and white (the template uses no red)
	for i := 0; i < len(img.Pix); i += 4 {
		c := color.NRGBA{img.Pix[i], img.Pix[i+1], img.Pix[i+2], img.Pix[i+3]}
		if c != (color.NRGBA{0, 0, 0, 255}) && c != (color.NRGBA{255, 255, 255, 255}) {
			t.Fatalf("pixel %d is %v, want black or white", i/4, c)
		}
	}

	// Every element drew something where the editor placed it
	for name, r := range map[string]image.Rectangle{
		"logo":       image.Rect(12, 7, 40, 33),
		"title":      image.Rect(46, 8, 228, 31),
		"rule":       image.Rect(12, 35, 228, 37),
		"qr":         image.Rect(10, 44, 114, 148),
		"asset_name": image.Rect(122, 50, 228, 68),
		"asset_type": image.Rect(122, 84, 228, 101),
		"site":       image.Rect(122, 114, 228, 131),
	} {
		if blackIn(img, r) < 20 {
			t.Errorf("%s: no ink in %v", name, r)
		}
	}
	// Margins stay white
	if n := blackIn(img, image.Rect(0, 152, 240, 160)); n != 0 {
		t.Errorf("%d black pixels in the bottom margin", n)
	}

	checkGolden(t, "asset-tag", img)
}

func TestRenderTemplateFill(t *testing.T) {
	p := newPrinter(t)

	missing := map[string]string{"uuid": "x", "asset_name": "a", "asset_type": "b"}
	_, err := p.RenderTemplate(assetTag, missing, nil)
	if !errors.Is(err, ErrOperation) || !strings.Contains(err.Error(), "site") {
		t.Errorf("missing required field: %v", err)
	}

	// Non-strict renders the raw tag instead
	img, err := p.RenderTemplate(assetTag, missing, &TemplateOptions{Strict: Bool(false)})
	if err != nil {
		t.Fatal(err)
	}
	if blackIn(img, image.Rect(122, 114, 228, 131)) == 0 {
		t.Error("non-strict: {site} not drawn")
	}

	// A shorter value shrinks less and a longer one must still stay inside its box
	long := map[string]string{}
	for k, v := range assetData {
		long[k] = v
	}
	long["asset_name"] = "Oppenheimer-Compute-0042"
	img, err = p.RenderTemplate(assetTag, long, nil)
	if err != nil {
		t.Fatal(err)
	}
	if n := blackIn(img, image.Rect(229, 40, 240, 152)); n != 0 {
		t.Errorf("long value overflows its box: %d black pixels right of x=228", n)
	}

	if _, err := p.RenderTemplate(packJSON(t, []byte(`{"format":"nope"}`), nil), nil, nil); err == nil {
		t.Error("invalid template accepted")
	}
	if _, err := p.RenderTemplate([]byte(`not a package`), nil, nil); !errors.Is(err, ErrInvalidArgument) {
		t.Errorf("non-package template: %v", err)
	}
}

// imageTemplate is a 64x64 label with a single image element, src the image path in the package.
func imageTemplate(t *testing.T, src string, files map[string][]byte) []byte {
	return packJSON(t, []byte(fmt.Sprintf(`{"format":"niimblue-template","version":1,
		"label":{"width":64,"height":64,"dpmm":8,"printDirection":"top"},
		"elements":[{"type":"image","x":16,"y":16,"width":32,"height":32,"src":%q}]}`, src)), files)
}

func TestRenderTemplateImageFormats(t *testing.T) {
	p := newPrinter(t)

	// Black square with a transparent hole, as PNG (decoded by the library) ...
	sq := image.NewNRGBA(image.Rect(0, 0, 8, 8))
	for y := 0; y < 8; y++ {
		for x := 0; x < 8; x++ {
			if x < 2 || x >= 6 || y < 2 || y >= 6 {
				sq.SetNRGBA(x, y, color.NRGBA{0, 0, 0, 255})
			}
		}
	}
	var pngBuf bytes.Buffer
	_ = png.Encode(&pngBuf, sq)
	img, err := p.RenderTemplate(imageTemplate(t, "images/sq.png", map[string][]byte{"images/sq.png": pngBuf.Bytes()}), nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if blackIn(img, image.Rect(16, 16, 48, 24)) != 32*8 || blackIn(img, image.Rect(26, 26, 38, 38)) != 0 {
		t.Error("PNG image: frame not black or hole not white")
	}
	if blackIn(img, image.Rect(0, 0, 64, 16)) != 0 {
		t.Error("PNG image drawn outside its box")
	}

	// ... and as JPEG (converted to PNG by the Go binding)
	solid := image.NewGray(image.Rect(0, 0, 8, 8))
	var jpgBuf bytes.Buffer
	_ = jpeg.Encode(&jpgBuf, solid, &jpeg.Options{Quality: 95})
	img, err = p.RenderTemplate(imageTemplate(t, "images/solid.jpg", map[string][]byte{"images/solid.jpg": jpgBuf.Bytes()}), nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if n := blackIn(img, image.Rect(16, 16, 48, 48)); n != 32*32 {
		t.Errorf("JPEG image: %d of %d pixels black", n, 32*32)
	}

	if _, err := p.RenderTemplate(imageTemplate(t, "https://example.com/logo.png", nil), nil, nil); err == nil ||
		!strings.Contains(err.Error(), "invalid path") {
		t.Errorf("remote image URL: %v", err)
	}
}

func TestRegisterFont(t *testing.T) {
	p := newPrinter(t)

	fonts, err := p.Fonts()
	if err != nil {
		t.Fatal(err)
	}
	if fmt.Sprint(fonts) != "[]" {
		// Built-in fonts load on first use
		t.Logf("fonts before first render: %v", fonts)
	}

	text := func(family, weight string) []byte {
		return packJSON(t, []byte(fmt.Sprintf(`{"format":"niimblue-template","version":1,
			"label":{"width":200,"height":48,"dpmm":8,"printDirection":"top"},
			"elements":[{"type":"text","x":8,"y":8,"width":184,"text":"Hamburgefonts",
				"font":{"family":%q,"size":24,"weight":%q}}]}`, family, weight)), nil)
	}

	bold, err := p.RenderTemplate(text("Noto Sans", "bold"), nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	regular, err := p.RenderTemplate(text("Noto Sans", "normal"), nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if blackIn(bold, bold.Rect) <= blackIn(regular, regular.Rect) {
		t.Error("bold does not have more ink than regular")
	}

	// Register the built-in bold face under a new family as its regular weight:
	// rendering it as "normal" must match built-in bold exactly.
	ttf, err := os.ReadFile(filepath.Join("..", "third_party", "fonts", "NotoSans-Bold.ttf"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := p.RegisterFont("Test Face", ttf, 400, false); err != nil {
		t.Fatal(err)
	}
	custom, err := p.RenderTemplate(text("Test Face", "normal"), nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(custom.Pix, bold.Pix) {
		t.Error("registered font renders differently from the same built-in font")
	}

	fonts, err = p.Fonts()
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(fmt.Sprint(fonts), "{Test Face 400 false}") || !strings.Contains(fmt.Sprint(fonts), "{Noto Sans 700 false}") {
		t.Errorf("fonts: %v", fonts)
	}

	_, err = p.RegisterFont("Web", append([]byte("wOF2"), make([]byte, 64)...), 400, false)
	if err == nil || !strings.Contains(err.Error(), "WOFF") {
		t.Errorf("WOFF2 font: %v", err)
	}
	if _, err := p.RegisterFont("Junk", []byte("not a font at all"), 400, false); err == nil {
		t.Error("junk font accepted")
	}
}

func TestTemplateTags(t *testing.T) {
	p := newPrinter(t)
	tags, err := p.TemplateTags(assetTag)
	if err != nil {
		t.Fatal(err)
	}
	if got := strings.Join(tags, ","); got != "uuid,asset_name,asset_type,site" {
		t.Errorf("tags = %s", got)
	}
}

func TestPrintTemplate(t *testing.T) {
	p := newPrinter(t)
	ev := recordEvents(t, p)

	if _, err := p.PrintTemplate(assetTag, []map[string]string{assetData}, nil); err == nil {
		t.Error("print without a printer succeeded")
	}

	if _, err := p.ConnectVirtual(b1Dump, noHeartbeat); err != nil {
		t.Fatal(err)
	}

	// The recorded B1 dump always reports "page 1 of 1 done", so the virtual
	// printer can only finish single page jobs.
	opts := &TemplatePrintOptions{Quantity: 1, StatusPollIntervalMs: 20}
	res, err := p.PrintTemplate(assetTag, []map[string]string{assetData}, opts)
	if err != nil {
		t.Fatal(err)
	}
	if res.PrintTask != "B1" || res.Labels != 1 || res.Pages != 1 {
		t.Errorf("result %+v", res)
	}
	if ev.count("printend") != 1 {
		t.Errorf("events: %v", ev.counts)
	}

	// Bad data fails before anything is sent to the printer
	before := ev.count("printprogress")
	_, err = p.PrintTemplate(assetTag, []map[string]string{assetData, {"uuid": "x"}}, opts)
	if err == nil || !strings.Contains(err.Error(), "asset_name") {
		t.Errorf("missing field in second row: %v", err)
	}
	if ev.count("printprogress") != before {
		t.Error("printing started despite invalid data")
	}

	if _, err := p.PrintTemplate(assetTag, nil, nil); !errors.Is(err, ErrInvalidArgument) {
		t.Errorf("no rows: %v", err)
	}
}

// withPrintDirection returns the template with label.printDirection replaced.
func withPrintDirection(t *testing.T, pkg []byte, dir string) []byte {
	t.Helper()
	files := unzipFiles(t, pkg)
	var m map[string]any
	if err := json.Unmarshal(files["template.json"], &m); err != nil {
		t.Fatal(err)
	}
	m["label"].(map[string]any)["printDirection"] = dir
	b, err := json.Marshal(m)
	if err != nil {
		t.Fatal(err)
	}
	delete(files, "template.json")
	return packJSON(t, b, files)
}
