package niimblue

import (
	"encoding/json"
	"image"
)

// ConnectOptions for the Connect* methods. Zero values use library defaults.
type ConnectOptions struct {
	// Heartbeat enables periodic status polling (default true when nil).
	Heartbeat           *bool `json:"heartbeat,omitempty"`
	HeartbeatIntervalMs int   `json:"heartbeatIntervalMs,omitempty"`
	PacketIntervalMs    int   `json:"packetIntervalMs,omitempty"`
	Debug               bool  `json:"debug,omitempty"`
}

// Bool returns a pointer to b (for ConnectOptions.Heartbeat).
func Bool(b bool) *bool { return &b }

// Label types (niimbluelib LabelType).
const (
	LabelWithGaps       = 1
	LabelBlack          = 2
	LabelContinuous     = 3
	LabelPerforated     = 4
	LabelTransparent    = 5
	LabelPvcTag         = 6
	LabelBlackMarkGap   = 10
	LabelHeatShrinkTube = 11
)

// Page colors (niimbluelib PageColorType).
const (
	PageSingleColor = 0
	PageDoubleColor = 1
	PageGrayscale   = 3
)

// PrintOptions for Print / PrintRaw. Zero values use defaults detected from the printer model.
type PrintOptions struct {
	Format    string `json:"format,omitempty"` // "rgba" (default), "rgb", "gray"; set by Print
	Stride    int    `json:"stride,omitempty"` // bytes per row, default width*bpp
	Quantity  int    `json:"quantity,omitempty"`
	Density   int    `json:"density,omitempty"`
	LabelType int    `json:"labelType,omitempty"`
	PageColor int    `json:"pageColor,omitempty"`
	// PrintTask overrides the detected task ("B1", "D110", "D110M_V4", ...).
	PrintTask string `json:"printTask,omitempty"`
	// PrintDirection "left" (rotate 90°) or "top"; default from the model.
	PrintDirection string `json:"printDirection,omitempty"`
	Speed          *int   `json:"speed,omitempty"`
	// Threshold: pixels with luminance below it print black (default 128).
	Threshold            int `json:"threshold,omitempty"`
	StatusPollIntervalMs int `json:"statusPollIntervalMs,omitempty"`
	StatusTimeoutMs      int `json:"statusTimeoutMs,omitempty"`
	PageTimeoutMs        int `json:"pageTimeoutMs,omitempty"`
	// Label is free text shown in job snapshots (Jobs, events).
	Label string `json:"label,omitempty"`
}

// PrintResult describes a finished print job.
type PrintResult struct {
	PrintTask string `json:"printTask"`
	// Cols / Rows of the printed image (Print / PrintRaw only).
	Cols int `json:"cols,omitempty"`
	Rows int `json:"rows,omitempty"`
	// Pages printed, including copies.
	Pages int `json:"pages"`
	// JobID of the print queue job.
	JobID int `json:"jobId"`
	// Images of a PrintBatch job.
	Images []PageResult `json:"images,omitempty"`
}

// PrinterInfo is fetched during connect.
type PrinterInfo struct {
	ConnectResult   int    `json:"connectResult"`
	ProtocolVersion int    `json:"protocolVersion"`
	ModelID         int    `json:"modelId"`
	Serial          string `json:"serial"`
	Mac             string `json:"mac"`
	BatteryPercents int    `json:"batteryPercents"`
	PrintheadWidth  int    `json:"printheadWidth"`
	SupportColor    bool   `json:"supportColor"`
	SoftwareVersion string `json:"softwareVersion"`
	HardwareVersion string `json:"hardwareVersion"`
	ResolutionClass int    `json:"resolutionClass"`
	Settings        struct {
		ConnectionSound  bool `json:"connectionSound"`
		PowerSound       bool `json:"powerSound"`
		AutoShutdownTime int  `json:"autoShutdownTime"`
	} `json:"settings"`
}

// ModelMetadata from niimbluelib's model library.
type ModelMetadata struct {
	Model           string `json:"model"`
	ID              []int  `json:"id"`
	DPI             int    `json:"dpi"`
	PrintDirection  string `json:"printDirection"`
	PrintheadPixels int    `json:"printheadPixels"`
	PaperTypes      []int  `json:"paperTypes"`
	DensityMin      int    `json:"densityMin"`
	DensityMax      int    `json:"densityMax"`
	DensityDefault  int    `json:"densityDefault"`
}

// ConnectionInfo is returned by the Connect* methods.
type ConnectionInfo struct {
	DeviceName    string          `json:"deviceName"`
	Result        int             `json:"result"`
	PrinterInfo   PrinterInfo     `json:"printerInfo"`
	ModelMetadata *ModelMetadata  `json:"modelMetadata"`
	PrintTask     string          `json:"printTask"`
	Raw           json.RawMessage `json:"-"`
}

// UnmarshalJSON keeps the whole connect result in Raw.
func (c *ConnectionInfo) UnmarshalJSON(b []byte) error {
	type plain ConnectionInfo
	var v plain
	if err := json.Unmarshal(b, &v); err != nil {
		return err
	}
	*c = ConnectionInfo(v)
	c.Raw = append(json.RawMessage(nil), b...)
	return nil
}

// HeartbeatData is the printer status.
type HeartbeatData struct {
	BatteryPercents   *int  `json:"batteryPercents,omitempty"`
	Temp              *int  `json:"temp,omitempty"`
	LidClosed         *bool `json:"lidClosed,omitempty"`
	PaperInserted     *bool `json:"paperInserted,omitempty"`
	PaperRfidSuccess  *bool `json:"paperRfidSuccess,omitempty"`
	RibbonInserted    *bool `json:"ribbonInserted,omitempty"`
	RibbonRfidSuccess *bool `json:"ribbonRfidSuccess,omitempty"`
}

// PrintProgress is the payload of "printprogress" events.
type PrintProgress struct {
	Page              int `json:"page"`
	PagesTotal        int `json:"pagesTotal"`
	PagePrintProgress int `json:"pagePrintProgress"`
	PageFeedProgress  int `json:"pageFeedProgress"`
}

// Print prints an image.Image (any color model; transparency is composited on white).
func (p *Printer) Print(img image.Image, opts *PrintOptions) (*PrintResult, error) {
	o := PrintOptions{}
	if opts != nil {
		o = *opts
	}
	pix, w, h, format, stride := imagePixels(img)
	o.Format, o.Stride = format, stride
	return p.PrintRaw(pix, w, h, &o)
}
