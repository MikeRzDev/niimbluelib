package niimblue

import (
	"encoding/json"
	"image"
	"image/color"
	"image/draw"
	"strconv"
	"time"
)

// Every print (Print, PrintRaw, PrintBatch, Submit, PrintTemplate) is a job in
// the library's FIFO print queue: one job prints at a time, so prints from
// several goroutines wait for their turn instead of mixing their packets.

// JobState of a print job.
type JobState string

const (
	JobQueued    JobState = "queued"
	JobPrinting  JobState = "printing"
	JobDone      JobState = "done"
	JobFailed    JobState = "failed"
	JobCancelled JobState = "cancelled"
)

// Finished reports whether the job left the queue (done, failed or cancelled).
func (s JobState) Finished() bool { return s == JobDone || s == JobFailed || s == JobCancelled }

func msTime(ms int64) time.Time {
	if ms == 0 {
		return time.Time{}
	}
	return time.UnixMilli(ms)
}

// CreatedAt, StartedAt and FinishedAt return the job times (zero time when not reached).
func (j *Job) CreatedAt() time.Time  { return msTime(j.CreatedAtMs) }
func (j *Job) StartedAt() time.Time  { return msTime(j.StartedAtMs) }
func (j *Job) FinishedAt() time.Time { return msTime(j.FinishedAtMs) }

// PrintResult decodes the result of a done image print job.
func (j *Job) PrintResult() (*PrintResult, error) {
	var r PrintResult
	if len(j.Result) == 0 {
		return nil, &Error{Code: codeJS, Message: "job has no result (state " + string(j.State) + ")"}
	}
	return &r, json.Unmarshal(j.Result, &r)
}

// Page is one image of a PrintBatch / Submit job.
type Page struct {
	Image image.Image
	// Quantity of copies of this page (default: PrintOptions.Quantity, else 1).
	Quantity int
	// Optional overrides of the job options.
	Threshold      int
	PrintDirection string
}

// imagePixels converts an image to a pixel buffer niim_print understands,
// without copying when the layout already fits.
func imagePixels(img image.Image) (pix []byte, width, height int, format string, stride int) {
	b := img.Bounds()
	switch m := img.(type) {
	case *image.Gray:
		if m.Rect.Min == (image.Point{}) {
			return m.Pix, b.Dx(), b.Dy(), "gray", m.Stride
		}
	case *image.RGBA:
		// RGBA is alpha-premultiplied; only use it directly when opaque.
		if m.Rect.Min == (image.Point{}) && m.Opaque() {
			return m.Pix, b.Dx(), b.Dy(), "rgba", m.Stride
		}
	case *image.NRGBA:
		if m.Rect.Min == (image.Point{}) {
			return m.Pix, b.Dx(), b.Dy(), "rgba", m.Stride
		}
	}

	n := image.NewNRGBA(image.Rect(0, 0, b.Dx(), b.Dy()))
	draw.Draw(n, n.Bounds(), &image.Uniform{C: color.White}, image.Point{}, draw.Src)
	draw.Draw(n, n.Bounds(), img, b.Min, draw.Over)
	return n.Pix, b.Dx(), b.Dy(), "rgba", n.Stride
}

// PrintBatch prints several different images as one print job and waits for it.
// opts apply to all pages; Page fields override quantity, threshold and direction.
func (p *Printer) PrintBatch(pages []Page, opts *PrintOptions) (*PrintResult, error) {
	raw, err := rawPages(pages)
	if err != nil {
		return nil, err
	}
	return p.printBatchRaw(raw, batchOptions(opts))
}

// Submit queues a print job and returns right away. Use WaitJob for the result.
func (p *Printer) Submit(pages []Page, opts *PrintOptions) (*Job, error) {
	raw, err := rawPages(pages)
	if err != nil {
		return nil, err
	}
	return p.submitRaw(raw, batchOptions(opts))
}

// batchOptions drops format and stride: they are per page here.
func batchOptions(opts *PrintOptions) *PrintOptions {
	if opts == nil {
		return nil
	}
	o := *opts
	o.Format, o.Stride = "", 0
	return &o
}

type pageOptions struct {
	Format         string `json:"format,omitempty"`
	Stride         int    `json:"stride,omitempty"`
	Quantity       int    `json:"quantity,omitempty"`
	Threshold      int    `json:"threshold,omitempty"`
	PrintDirection string `json:"printDirection,omitempty"`
}

// rawPages converts images to the generated RawPage records.
func rawPages(pages []Page) ([]RawPage, error) {
	if len(pages) == 0 {
		return nil, &Error{Code: codeInvalidArg, Message: "no pages"}
	}
	raw := make([]RawPage, len(pages))
	for i, pg := range pages {
		if pg.Image == nil {
			return nil, &Error{Code: codeInvalidArg, Message: "page " + strconv.Itoa(i+1) + ": image is nil"}
		}
		pix, w, h, format, stride := imagePixels(pg.Image)
		if len(pix) == 0 || w <= 0 || h <= 0 {
			return nil, &Error{Code: codeInvalidArg, Message: "page " + strconv.Itoa(i+1) + ": empty image"}
		}
		opts, err := json.Marshal(pageOptions{
			Format:         format,
			Stride:         stride,
			Quantity:       pg.Quantity,
			Threshold:      pg.Threshold,
			PrintDirection: pg.PrintDirection,
		})
		if err != nil {
			return nil, err
		}
		raw[i] = RawPage{Pixels: pix, Width: w, Height: h, Options: opts}
	}
	return raw, nil
}
