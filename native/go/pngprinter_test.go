package niimblue

import (
	"encoding/json"
	"fmt"
	"image"
	"image/color"
	"os"
	"path/filepath"
	"sync"
	"testing"
)

// The PNG printer is the test print: jobs printed to it run the real queue,
// print task and packets, and the PNG is the label as the printer puts it on
// paper. Expected tags here are computed independently from the source images.

// connectPNG connects to the PNG printer and fails the test on error.
func connectPNG(t *testing.T, opts *PNGPrinterOptions) *Printer {
	t.Helper()
	p := newPrinter(t)
	if _, err := p.ConnectPNG(opts); err != nil {
		t.Fatal(err)
	}
	return p
}

// dotsOf thresholds an image into a w x h black (true) / white grid.
func dotsOf(img image.Image) [][]bool {
	b := img.Bounds()
	out := make([][]bool, b.Dy())
	for y := range out {
		out[y] = make([]bool, b.Dx())
		for x := range out[y] {
			g := color.GrayModel.Convert(img.At(b.Min.X+x, b.Min.Y+y)).(color.Gray)
			out[y][x] = g.Y < 128
		}
	}
	return out
}

func blankDots(w, h int) [][]bool {
	out := make([][]bool, h)
	for y := range out {
		out[y] = make([]bool, w)
	}
	return out
}

func sameDots(got, want [][]bool) error {
	if len(got) != len(want) || len(got) > 0 && len(got[0]) != len(want[0]) {
		gw, ww := 0, 0
		if len(got) > 0 {
			gw = len(got[0])
		}
		if len(want) > 0 {
			ww = len(want[0])
		}
		return fmt.Errorf("tag is %dx%d, want %dx%d", gw, len(got), ww, len(want))
	}
	for y := range want {
		for x := range want[y] {
			if got[y][x] != want[y][x] {
				return fmt.Errorf("dot (%d,%d) black=%v, want %v", x, y, got[y][x], want[y][x])
			}
		}
	}
	return nil
}

// pages returns the job's PNG pages (decoded) and saves them to $NIIM_PNG_DIR.
func pages(t *testing.T, p *Printer, jobID int) []PNGPage {
	t.Helper()
	pgs, err := p.PNGPages(jobID)
	if err != nil {
		t.Fatal(err)
	}
	if dir := os.Getenv("NIIM_PNG_DIR"); dir != "" {
		_ = os.MkdirAll(dir, 0o755)
		for _, pg := range pgs {
			name := fmt.Sprintf("%s-job%d-page%d-x%d.png", filepath.Base(t.Name()), pg.JobID, pg.Page, pg.Copies)
			_ = os.WriteFile(filepath.Join(dir, name), pg.PNG, 0o644)
		}
	}
	return pgs
}

func tagDots(t *testing.T, pg PNGPage) [][]bool {
	t.Helper()
	img, err := pg.Image()
	if err != nil {
		t.Fatalf("page %d: bad PNG: %v", pg.Page, err)
	}
	if img.Bounds().Dx() != pg.Width || img.Bounds().Dy() != pg.Height {
		t.Fatalf("page %d: PNG %v, reported %dx%d", pg.Page, img.Bounds(), pg.Width, pg.Height)
	}
	return dotsOf(img)
}

func TestPNGPrinterPrint(t *testing.T) {
	p := newPrinter(t)
	ev := recordSeq(p)
	info, err := p.ConnectPNG(nil)
	if err != nil {
		t.Fatal(err)
	}
	if info.PrintTask != "B1" || info.ModelMetadata == nil || info.ModelMetadata.Model != "B1" {
		t.Fatalf("PNG printer connect: %+v", info)
	}

	res, err := p.Print(testImage(), &PrintOptions{StatusPollIntervalMs: 5})
	if err != nil {
		t.Fatal(err)
	}
	pgs := pages(t, p, res.JobID)
	if len(pgs) != 1 || pgs[0].Copies != 1 || pgs[0].Page != 1 || pgs[0].JobID != res.JobID {
		t.Fatalf("pages %+v", pgs)
	}
	if err := sameDots(tagDots(t, pgs[0]), dotsOf(testImage())); err != nil {
		t.Error(err)
	}

	evs := ev.all("pngpage")
	var e struct {
		JobID  int     `json:"jobId"`
		Width  int     `json:"width"`
		PNG    *string `json:"png"`
		Copies int     `json:"copies"`
	}
	if len(evs) != 1 || json.Unmarshal(evs[0].payload, &e) != nil || e.JobID != res.JobID || e.Width != 120 || e.PNG != nil {
		t.Errorf("pngpage events %v", evs)
	}

	if n, err := p.ClearPNGPages(); err != nil || n != 1 {
		t.Errorf("ClearPNGPages = %d %v", n, err)
	}
	if pgs, _ := p.PNGPages(0); len(pgs) != 0 {
		t.Errorf("pages after clear: %d", len(pgs))
	}
}

func TestPNGPrinterBatch(t *testing.T) {
	p := connectPNG(t, nil)
	sources := []image.Image{solidImage(48, 24), solidImage(64, 32), testImage()}
	res, err := p.PrintBatch([]Page{
		{Image: sources[0], Quantity: 1},
		{Image: sources[1], Quantity: 2},
		{Image: sources[2], Quantity: 3},
	}, &PrintOptions{StatusPollIntervalMs: 5})
	if err != nil {
		t.Fatal(err)
	}
	pgs := pages(t, p, res.JobID)
	if len(pgs) != 3 {
		t.Fatalf("%d pages", len(pgs))
	}
	for i, src := range sources {
		if pgs[i].Page != i+1 || pgs[i].Copies != i+1 {
			t.Errorf("page %d: %+v", i+1, pgs[i])
		}
		if err := sameDots(tagDots(t, pgs[i]), dotsOf(src)); err != nil {
			t.Errorf("page %d: %v", i+1, err)
		}
	}
}

// rotatedOnLabel is what a top-feeding printer burns when the image was encoded
// for "left" (rotated 90° clockwise): the strip is h dots wide, centered on a
// w-dot label, and line f shows column f of the design read bottom to top.
func rotatedOnLabel(design [][]bool) [][]bool {
	h := len(design)
	w := len(design[0])
	out := blankDots(w, h)
	off := (w - h) / 2
	for f := 0; f < h && f < w; f++ {
		for c := 0; c < h; c++ {
			if x := off + c; x >= 0 && x < w {
				out[f][x] = design[h-1-c][f]
			}
		}
	}
	return out
}

// The case that went wrong on a real B1: a template with printDirection "left"
// on a printer that feeds "top" prints rotated and cut off. The PNG printer
// must show exactly that; the matching direction shows the design.
func TestPNGPrinterTemplateDirection(t *testing.T) {
	design := dotsOf(mustRenderDesign(t))
	for _, dir := range []string{"top", "left"} {
		t.Run(dir, func(t *testing.T) {
			p := connectPNG(t, &PNGPrinterOptions{Model: "B1"})
			res, err := p.PrintTemplate(withPrintDirection(t, assetTag, dir), []map[string]string{assetData},
				&TemplatePrintOptions{StatusPollIntervalMs: 5})
			if err != nil {
				t.Fatal(err)
			}
			pgs := pages(t, p, res.JobID)
			if len(pgs) != 1 || pgs[0].Width != 240 || pgs[0].Height != 160 {
				t.Fatalf("pages %+v", pgs)
			}
			want := design
			if dir == "left" {
				want = rotatedOnLabel(design)
			}
			if err := sameDots(tagDots(t, pgs[0]), want); err != nil {
				t.Errorf("%s template on B1: %v", dir, err)
			}
		})
	}
}

func mustRenderDesign(t *testing.T) image.Image {
	t.Helper()
	p := newPrinter(t)
	img, err := p.RenderTemplate(assetTag, assetData, nil)
	if err != nil {
		t.Fatal(err)
	}
	return img
}

// A model feeding "left" (D110): images are rotated for it and the tag comes out as designed.
func TestPNGPrinterLeftFeedingModel(t *testing.T) {
	p := connectPNG(t, &PNGPrinterOptions{Model: "D110"})
	img := solidImage(120, 96) // D110 head is 96 dots
	res, err := p.Print(img, &PrintOptions{StatusPollIntervalMs: 5})
	if err != nil {
		t.Fatal(err)
	}
	if res.PrintTask == "B1" {
		t.Errorf("D110 printed with task %s", res.PrintTask)
	}
	pgs := pages(t, p, res.JobID)
	if len(pgs) != 1 {
		t.Fatalf("%d pages", len(pgs))
	}
	if err := sameDots(tagDots(t, pgs[0]), dotsOf(img)); err != nil {
		t.Error(err)
	}
}

// Physical limits: a label (roll) narrower than the image and a narrower
// print head both cut the tag.
func TestPNGPrinterCutsAtLabelAndHead(t *testing.T) {
	img := testImage() // 120x64, checkerboard from x=4 to 115
	src := dotsOf(img)

	t.Run("label", func(t *testing.T) {
		p := connectPNG(t, &PNGPrinterOptions{LabelWidth: 100, LabelHeight: 50})
		res, err := p.Print(img, &PrintOptions{StatusPollIntervalMs: 5})
		if err != nil {
			t.Fatal(err)
		}
		pgs := pages(t, p, res.JobID)
		// 120 sent dots centered on 100: 10 cut on each side, feed stops after 50 lines
		want := blankDots(100, 50)
		for y := 0; y < 50; y++ {
			for x := 0; x < 100; x++ {
				want[y][x] = src[y][x+10]
			}
		}
		if err := sameDots(tagDots(t, pgs[0]), want); err != nil {
			t.Error(err)
		}
	})

	t.Run("head", func(t *testing.T) {
		p := connectPNG(t, &PNGPrinterOptions{PrintheadPixels: 96})
		res, err := p.Print(img, &PrintOptions{StatusPollIntervalMs: 5})
		if err != nil {
			t.Fatal(err)
		}
		pgs := pages(t, p, res.JobID)
		// 120 dots on a 96 dot head: 12 dots on each side are never burned
		want := blankDots(120, 64)
		for y := 0; y < 64; y++ {
			for x := 12; x < 108; x++ {
				want[y][x] = src[y][x]
			}
		}
		if err := sameDots(tagDots(t, pgs[0]), want); err != nil {
			t.Error(err)
		}
	})
}

// Concurrent prints through the queue: every job gets exactly its own tag.
func TestPNGPrinterConcurrentJobs(t *testing.T) {
	p := connectPNG(t, nil)
	const n = 4
	var wg sync.WaitGroup
	type out struct {
		w   int
		res *PrintResult
		err error
	}
	results := make(chan out, n)
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(w int) {
			defer wg.Done()
			res, err := p.Print(solidImage(w, 32), &PrintOptions{StatusPollIntervalMs: 5})
			results <- out{w, res, err}
		}(40 + i*16)
	}
	wg.Wait()
	close(results)
	for r := range results {
		if r.err != nil {
			t.Error(r.err)
			continue
		}
		pgs := pages(t, p, r.res.JobID)
		if len(pgs) != 1 {
			t.Errorf("job %d: %d pages", r.res.JobID, len(pgs))
			continue
		}
		if err := sameDots(tagDots(t, pgs[0]), dotsOf(solidImage(r.w, 32))); err != nil {
			t.Errorf("job %d (width %d): %v", r.res.JobID, r.w, err)
		}
	}
}

func TestPNGPrinterUnknownModel(t *testing.T) {
	p := newPrinter(t)
	if _, err := p.ConnectPNG(&PNGPrinterOptions{Model: "NOPE"}); err == nil {
		t.Error("unknown model accepted")
	}
}
