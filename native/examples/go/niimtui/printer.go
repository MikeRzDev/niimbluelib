package main

import (
	"context"
	_ "embed"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	tea "charm.land/bubbletea/v2"
	niimblue "github.com/MultiMote/niimbluelib/native/go"
)

// Recorded B1 session: lets the app run against a simulated printer.
// It only completes single-page print jobs.
//
//go:embed testdata/b1_print_dump.txt
var virtualB1Dump string

type deviceKind int

const (
	devSerial deviceKind = iota
	devBLE
	devVirtual
)

type device struct {
	kind deviceKind
	name string // serial path, BLE name, "Virtual B1"
	ble  bleDevice
}

func (d device) label() string {
	switch d.kind {
	case devBLE:
		name := d.name
		if name == "" {
			name = d.ble.Address.String()
		}
		return fmt.Sprintf("%-22s %4d dBm", name, d.ble.RSSI)
	case devVirtual:
		return "Virtual B1 (simulated)"
	}
	return d.name
}

/* ---- messages ---- */

type portsMsg struct {
	ports []string
	err   error
}

type scanMsg struct {
	devs []bleDevice
	err  error
}

type connectedMsg struct {
	dev  device
	info *niimblue.ConnectionInfo
	link *bleLink
	err  error
}

type disconnectedMsg struct{ err error }

type statusMsg struct {
	hb   *niimblue.HeartbeatData
	rfid *rfidSummary
	err  error
}

// eventMsg is a library event forwarded from the printer's event callback.
type eventMsg struct {
	name    string
	payload json.RawMessage
}

/* ---- commands (run off the UI goroutine; the printer blocks) ---- */

func listPortsCmd() tea.Cmd {
	return func() tea.Msg {
		ports, err := niimblue.ListSerialPorts()
		return portsMsg{ports, err}
	}
}

func scanCmd(d time.Duration) tea.Cmd {
	return func() tea.Msg {
		devs, err := scanPrinters(context.Background(), d)
		return scanMsg{devs, err}
	}
}

func connectCmd(p *niimblue.Printer, d device) tea.Cmd {
	return func() tea.Msg {
		opts := &niimblue.ConnectOptions{HeartbeatIntervalMs: 2000}
		var (
			info *niimblue.ConnectionInfo
			link *bleLink
			err  error
		)
		switch d.kind {
		case devSerial:
			info, err = p.ConnectSerial(d.name, opts)
		case devVirtual:
			// the recorded dump has no answers to repeated heartbeats
			opts.Heartbeat = niimblue.Bool(false)
			info, err = p.ConnectVirtual(virtualB1Dump, opts)
		case devBLE:
			link, err = dialBLE(d.ble)
			if err == nil {
				info, err = link.connect(p, opts)
				if err != nil {
					link.close()
					link = nil
				}
			}
		}
		return connectedMsg{dev: d, info: info, link: link, err: err}
	}
}

func disconnectCmd(p *niimblue.Printer, link *bleLink) tea.Cmd {
	return func() tea.Msg {
		err := p.Disconnect()
		if link != nil {
			link.close()
		}
		return disconnectedMsg{err}
	}
}

func statusCmd(p *niimblue.Printer) tea.Cmd {
	return func() tea.Msg {
		hb, err := p.Heartbeat()
		if err != nil {
			return statusMsg{err: err}
		}
		var rfid *rfidSummary
		if raw, err := p.RfidInfo(); err == nil {
			rfid = parseRfid(raw)
		}
		return statusMsg{hb: hb, rfid: rfid}
	}
}

/* ---- label roll info ---- */

type rfidInfo struct {
	TagPresent   bool   `json:"tagPresent"`
	BarCode      string `json:"barCode"`
	SerialNumber string `json:"serialNumber"`
	AllPaper     int    `json:"allPaper"`
	UsedPaper    int    `json:"usedPaper"`
}

type rfidSummary struct {
	present   bool
	barcode   string
	remaining int
	total     int
}

// parseRfid accepts both a plain RfidInfo and niimbluelib's CombinedRfidInfo.
func parseRfid(raw json.RawMessage) *rfidSummary {
	var combined struct {
		Label *rfidInfo `json:"labelRfidInfo"`
	}
	var info rfidInfo
	if json.Unmarshal(raw, &combined) == nil && combined.Label != nil {
		info = *combined.Label
	} else if json.Unmarshal(raw, &info) != nil {
		return nil
	}
	if !info.TagPresent {
		return &rfidSummary{}
	}
	return &rfidSummary{
		present:   true,
		barcode:   info.BarCode,
		remaining: info.AllPaper - info.UsedPaper,
		total:     info.AllPaper,
	}
}

/* ---- status formatting ---- */

func yesNo(b *bool, yes, no string) string {
	if b == nil {
		return "-"
	}
	if *b {
		return yes
	}
	return no
}

func intOr(v *int, suffix string) string {
	if v == nil {
		return "-"
	}
	return fmt.Sprintf("%d%s", *v, suffix)
}

// statusRows is the printer status table: label, value.
func (m model) statusRows() [][2]string {
	if !m.connected {
		return [][2]string{{"State", "not connected"}}
	}
	info := m.info
	modelName := "unknown"
	dpi := ""
	if info.ModelMetadata != nil {
		modelName = info.ModelMetadata.Model
		dpi = fmt.Sprintf("%d dpi, prints %s", info.ModelMetadata.DPI, orientationShort(info.ModelMetadata.PrintDirection))
	}
	rows := [][2]string{
		{"State", "connected"},
		{"Device", m.dev.label()},
		{"Model", modelName},
		{"Head", dpi},
		{"Print task", info.PrintTask},
		{"Serial", info.PrinterInfo.Serial},
		{"Firmware", strings.TrimSpace(info.PrinterInfo.SoftwareVersion + " / hw " + info.PrinterInfo.HardwareVersion)},
	}
	if hb := m.hb; hb != nil {
		rows = append(rows,
			[2]string{"Battery", intOr(hb.BatteryPercents, "%")},
			[2]string{"Lid", yesNo(hb.LidClosed, "closed", "OPEN")},
			[2]string{"Paper", yesNo(hb.PaperInserted, "inserted", "MISSING")},
		)
	} else {
		rows = append(rows, [2]string{"Battery", fmt.Sprintf("%d%%", info.PrinterInfo.BatteryPercents)})
	}
	if r := m.rfid; r != nil {
		roll := "no RFID tag"
		if r.present {
			roll = fmt.Sprintf("%s, %d of %d left", r.barcode, r.remaining, r.total)
		}
		rows = append(rows, [2]string{"Label roll", roll})
	}
	if !m.hbAt.IsZero() {
		rows = append(rows, [2]string{"Updated", m.hbAt.Format("15:04:05")})
	}
	return rows
}
