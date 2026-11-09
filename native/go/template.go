package niimblue

/*
#include <stdlib.h>
#include "niimblue.h"
*/
import "C"

import (
	"archive/zip"
	"bytes"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"image"
	"image/png"
	"io"
	"strings"
	"unsafe"

	// Decoders for template images that are converted to PNG before rendering.
	_ "image/gif"
	_ "image/jpeg"
)

// TemplateOptions control how a template (.niim package) is rendered.
type TemplateOptions struct {
	// Threshold: pixels with luminance below it print black (default 128).
	Threshold int `json:"threshold,omitempty"`
	// Strict makes unresolved tags of required or undeclared fields an error
	// instead of printing the raw {tag}. Default true when nil.
	Strict *bool `json:"strict,omitempty"`
}

// TemplatePrintOptions for PrintTemplate. Zero values use defaults detected from the printer model.
type TemplatePrintOptions struct {
	TemplateOptions
	// Quantity is the number of copies of each label (default 1).
	Quantity  int `json:"quantity,omitempty"`
	Density   int `json:"density,omitempty"`
	LabelType int `json:"labelType,omitempty"`
	PageColor int `json:"pageColor,omitempty"`
	// PrintTask overrides the detected task ("B1", "D110", "D110M_V4", ...).
	PrintTask            string `json:"printTask,omitempty"`
	Speed                *int   `json:"speed,omitempty"`
	StatusPollIntervalMs int    `json:"statusPollIntervalMs,omitempty"`
	StatusTimeoutMs      int    `json:"statusTimeoutMs,omitempty"`
	PageTimeoutMs        int    `json:"pageTimeoutMs,omitempty"`
	// Label is free text shown in job snapshots (default: template title).
	Label string `json:"label,omitempty"`
}

// TemplatePrintResult describes a finished template print job.
type TemplatePrintResult struct {
	PrintTask string `json:"printTask"`
	// Labels is the number of data rows printed, Pages includes copies.
	Labels int `json:"labels"`
	Pages  int `json:"pages"`
	// JobID of the print queue job.
	JobID int `json:"jobId"`
}

// RenderTemplate renders a .niim template package (e.g. exported from the
// NiimBlue editor) with the given tag values, without a printer. The
// result contains only white, black and red pixels and is the design (not
// rotated for printDirection). For a test print, print to the PNG printer
// (ConnectPNG): it shows the label as the printer puts it on paper.
func (p *Printer) RenderTemplate(template []byte, data map[string]string, opts *TemplateOptions) (*image.NRGBA, error) {
	pkg, err := preparePackage(template)
	if err != nil {
		return nil, err
	}
	raw, err := p.templateCall(pkg, data, opts, func(t *C.uint8_t, n C.size_t, d, o *C.char, out **C.char) C.int {
		return C.niim_render_template(p.h, t, n, d, o, out)
	})
	if err != nil {
		return nil, err
	}

	var r struct {
		Width  int    `json:"width"`
		Height int    `json:"height"`
		Pixels string `json:"pixels"`
	}
	if err := json.Unmarshal(raw, &r); err != nil {
		return nil, err
	}
	pix, err := base64.StdEncoding.DecodeString(r.Pixels)
	if err != nil {
		return nil, fmt.Errorf("niimblue: bad render result: %w", err)
	}
	if r.Width <= 0 || r.Height <= 0 || len(pix) != r.Width*r.Height*4 {
		return nil, fmt.Errorf("niimblue: bad render result: %dx%d with %d bytes", r.Width, r.Height, len(pix))
	}
	return &image.NRGBA{Pix: pix, Stride: r.Width * 4, Rect: image.Rect(0, 0, r.Width, r.Height)}, nil
}

// PrintTemplate prints a .niim template package, one label per data row, on
// the connected printer. All labels are rendered before printing starts, so
// bad data (a missing required field, an invalid barcode value) fails without
// wasting labels.
//
//	tmpl, _ := os.ReadFile("asset-tag.niim")
//	res, err := p.PrintTemplate(tmpl, []map[string]string{
//		{"uuid": uuid.NewString(), "asset_name": "Oppenheimer", "asset_type": "Compute Node", "site": "Manhattan"},
//	}, nil)
func (p *Printer) PrintTemplate(template []byte, rows []map[string]string, opts *TemplatePrintOptions) (*TemplatePrintResult, error) {
	if len(rows) == 0 {
		return nil, &Error{Code: codeInvalidArg, Message: "no data rows to print"}
	}
	pkg, err := preparePackage(template)
	if err != nil {
		return nil, err
	}
	raw, err := p.templateCall(pkg, rows, opts, func(t *C.uint8_t, n C.size_t, d, o *C.char, out **C.char) C.int {
		return C.niim_print_template(p.h, t, n, d, o, out)
	})
	if err != nil {
		return nil, err
	}
	var r TemplatePrintResult
	return &r, json.Unmarshal(raw, &r)
}

// TemplateTags lists the tag names a .niim template package uses, e.g. ["uuid", "site"].
func (p *Printer) TemplateTags(template []byte) ([]string, error) {
	if !IsTemplatePackage(template) {
		return nil, errNotPackage
	}
	var tags []string
	return tags, p.callAPI("templateTags", nil, template, &tags)
}

// IsTemplatePackage reports whether the bytes are a .niim template package
// (a ZIP file with template.json and its images and fonts).
func IsTemplatePackage(data []byte) bool {
	return bytes.HasPrefix(data, []byte("PK\x03\x04"))
}

/* ---- helpers ---- */

var errNotPackage = &Error{Code: codeInvalidArg, Message: "template must be a .niim package (ZIP file with template.json)"}

func (p *Printer) templateCall(pkg []byte, data any, opts any,
	fn func(t *C.uint8_t, n C.size_t, d, o *C.char, out **C.char) C.int) (json.RawMessage, error) {
	var cd *C.char
	if data != nil {
		b, err := json.Marshal(data)
		if err != nil {
			return nil, err
		}
		cd = C.CString(string(b))
		defer C.free(unsafe.Pointer(cd))
	}

	co, free := optionsJSON(opts)
	defer free()

	// the library copies the package before the call returns
	var out *C.char
	rc := fn((*C.uint8_t)(unsafe.Pointer(&pkg[0])), C.size_t(len(pkg)), cd, co, &out)
	return result(rc, out)
}

var pngSignature = []byte("\x89PNG\r\n\x1a\n")

// preparePackage checks the template is a .niim package and converts images
// the library can't decode (JPEG, GIF, interlaced PNG) to plain PNG, keeping
// their file names (the library detects the format from the contents).
func preparePackage(pkg []byte) ([]byte, error) {
	if !IsTemplatePackage(pkg) {
		return nil, errNotPackage
	}
	zr, err := zip.NewReader(bytes.NewReader(pkg), int64(len(pkg)))
	if err != nil {
		return nil, &Error{Code: codeInvalidArg, Message: "invalid template package: " + err.Error()}
	}

	type entry struct {
		hdr  zip.FileHeader
		data []byte
	}
	entries := make([]entry, 0, len(zr.File))
	changed := false
	for _, f := range zr.File {
		if strings.HasSuffix(f.Name, "/") {
			continue
		}
		data, err := readZipFile(f)
		if err != nil {
			return nil, &Error{Code: codeInvalidArg, Message: fmt.Sprintf("invalid template package: %s: %v", f.Name, err)}
		}
		if f.Name != "mimetype" && f.Name != "template.json" {
			png, conv, err := imageAsPNG(data)
			if err != nil {
				return nil, &Error{Code: codeInvalidArg, Message: fmt.Sprintf("template package %s: %v", f.Name, err)}
			}
			if conv {
				data, changed = png, true
			}
		}
		entries = append(entries, entry{hdr: f.FileHeader, data: data})
	}
	if !changed {
		return pkg, nil
	}

	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	for _, e := range entries {
		hdr := e.hdr
		hdr.CompressedSize64, hdr.UncompressedSize64, hdr.CRC32 = 0, 0, 0
		w, err := zw.CreateHeader(&hdr)
		if err != nil {
			return nil, err
		}
		if _, err := w.Write(e.data); err != nil {
			return nil, err
		}
	}
	if err := zw.Close(); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

func readZipFile(f *zip.File) ([]byte, error) {
	rc, err := f.Open()
	if err != nil {
		return nil, err
	}
	defer rc.Close()
	return io.ReadAll(rc)
}

// imageAsPNG re-encodes JPEG, GIF and interlaced PNG images as plain PNG and
// reports whether it did; other files (plain PNG, fonts, SVG, ...) are left alone.
func imageAsPNG(data []byte) ([]byte, bool, error) {
	isPNG := bytes.HasPrefix(data, pngSignature)
	// IHDR interlace flag is byte 28 of the file
	if isPNG && len(data) > 28 && data[28] == 0 {
		return data, false, nil
	}
	isJPEG := bytes.HasPrefix(data, []byte{0xff, 0xd8, 0xff})
	isGIF := bytes.HasPrefix(data, []byte("GIF8"))
	if !isPNG && !isJPEG && !isGIF {
		return data, false, nil
	}
	img, format, err := image.Decode(bytes.NewReader(data))
	if err != nil {
		return nil, false, fmt.Errorf("unsupported image: %w", err)
	}
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		return nil, false, fmt.Errorf("re-encoding %s image as PNG: %w", format, err)
	}
	return buf.Bytes(), true, nil
}
