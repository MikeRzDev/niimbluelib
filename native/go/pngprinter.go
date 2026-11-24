package niimblue

import (
	"bytes"
	"image"
	"image/png"
)

// PNGPrinterOptions configure the PNG printer (ConnectPNG). Zero values use the model defaults.
type PNGPrinterOptions struct {
	// Model to simulate ("B1", "D110", ...; default "B1").
	Model string `json:"model,omitempty"`
	// ProtocolVersion reported for print task selection.
	ProtocolVersion int `json:"protocolVersion,omitempty"`
	// LabelWidth / LabelHeight: the physical label in dots, design orientation
	// (default: the size of the printed template or image).
	LabelWidth  int `json:"labelWidth,omitempty"`
	LabelHeight int `json:"labelHeight,omitempty"`
	// PrintheadPixels / PrintDirection override the model.
	PrintheadPixels int    `json:"printheadPixels,omitempty"`
	PrintDirection  string `json:"printDirection,omitempty"`
}

// Image decodes the page PNG.
func (pg *PNGPage) Image() (image.Image, error) { return png.Decode(bytes.NewReader(pg.PNG)) }
