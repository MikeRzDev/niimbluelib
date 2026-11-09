package main

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"

	"charm.land/bubbles/v2/textinput"
	tea "charm.land/bubbletea/v2"
	niimblue "github.com/MultiMote/niimbluelib/native/go"
	"github.com/google/uuid"
)

// field is one form input, for one template tag.
type field struct {
	name        string
	description string
	def         string
	required    bool
	input       textinput.Model
}

func isUUIDField(name string) bool {
	n := strings.ToLower(name)
	return strings.Contains(n, "uuid") || strings.Contains(n, "guid")
}

type labelInfo struct {
	title         string
	width, height int
	dpmm          float64
	direction     string
}

/* ---- messages ---- */

type templateLoadedMsg struct {
	path   string
	data   []byte
	info   labelInfo
	fields []field
	err    error
}

// testPrintedMsg: a test print rendered the label and wrote it as PNG.
type testPrintedMsg struct {
	path          string
	width, height int
	err           error
}

type printedMsg struct {
	res *niimblue.TemplatePrintResult
	err error
}

/* ---- template loading ---- */

func loadTemplateCmd(p *niimblue.Printer, path string) tea.Cmd {
	return func() tea.Msg {
		data, err := os.ReadFile(path)
		if err != nil {
			return templateLoadedMsg{path: path, err: err}
		}

		var t struct {
			Title string `json:"title"`
			Label struct {
				Width          float64 `json:"width"`
				Height         float64 `json:"height"`
				Dpmm           float64 `json:"dpmm"`
				PrintDirection string  `json:"printDirection"`
			} `json:"label"`
			Fields []struct {
				Name        string `json:"name"`
				Description string `json:"description"`
				Default     string `json:"default"`
				Required    bool   `json:"required"`
			} `json:"fields"`
		}
		tmplJSON, err := packageTemplateJSON(data)
		if err != nil {
			return templateLoadedMsg{path: path, err: err}
		}
		if err := json.Unmarshal(tmplJSON, &t); err != nil {
			return templateLoadedMsg{path: path, err: fmt.Errorf("not a template: %w", err)}
		}
		tags, err := p.TemplateTags(data)
		if err != nil {
			return templateLoadedMsg{path: path, err: err}
		}

		declared := map[string]int{}
		for i, f := range t.Fields {
			declared[f.Name] = i
		}
		fields := make([]field, 0, len(tags))
		for _, tag := range tags {
			f := field{name: tag, required: true}
			if i, ok := declared[tag]; ok {
				d := t.Fields[i]
				f.description, f.def, f.required = d.Description, d.Default, d.Required
			}
			f.input = newInput(f)
			if isUUIDField(tag) && f.def == "" {
				f.input.SetValue(uuid.NewString())
			}
			fields = append(fields, f)
		}

		info := labelInfo{
			title:     t.Title,
			width:     int(t.Label.Width),
			height:    int(t.Label.Height),
			dpmm:      t.Label.Dpmm,
			direction: t.Label.PrintDirection,
		}
		return templateLoadedMsg{path: path, data: data, info: info, fields: fields}
	}
}

// packageTemplateJSON returns template.json of a .niim template package.
func packageTemplateJSON(pkg []byte) ([]byte, error) {
	if !niimblue.IsTemplatePackage(pkg) {
		return nil, fmt.Errorf("not a .niim template package")
	}
	zr, err := zip.NewReader(bytes.NewReader(pkg), int64(len(pkg)))
	if err != nil {
		return nil, fmt.Errorf("not a .niim template package: %w", err)
	}
	f, err := zr.Open("template.json")
	if err != nil {
		return nil, fmt.Errorf("not a .niim template package: %w", err)
	}
	defer f.Close()
	return io.ReadAll(f)
}

func newInput(f field) textinput.Model {
	ti := textinput.New()
	ti.Prompt = ""
	ti.CharLimit = 512
	ti.SetWidth(36)
	switch {
	case f.def != "":
		ti.Placeholder = "default: " + f.def
	case f.description != "":
		ti.Placeholder = f.description
	case !f.required:
		ti.Placeholder = "optional"
	}
	return ti
}

func newCopiesInput() textinput.Model {
	ti := textinput.New()
	ti.Prompt = ""
	ti.CharLimit = 3
	ti.SetWidth(5)
	ti.SetValue("1")
	return ti
}

// formData collects the tag values. Empty inputs are left out so template
// defaults apply (and missing required fields are reported by the library).
func formData(fields []field) map[string]string {
	data := map[string]string{}
	for _, f := range fields {
		if v := f.input.Value(); v != "" {
			data[f.name] = v
		}
	}
	return data
}

/* ---- render / print ---- */

// testPrintCmd prints the label to the PNG printer and writes the tag to path:
// the same queue, print task and packets as a real print, laid on the label
// the way the printer does, so a template with the wrong printDirection,
// label size or printhead width shows up rotated / cut off here too. It
// simulates the connected printer's model (B1 when none is connected).
func testPrintCmd(p *niimblue.Printer, tmpl []byte, data map[string]string, path string) tea.Cmd {
	return func() tea.Msg {
		model := "B1"
		if meta, err := p.ModelMetadata(); err == nil && meta != nil && meta.Model != "" {
			model = meta.Model
		}

		sim, err := niimblue.New()
		if err != nil {
			return testPrintedMsg{err: err}
		}
		defer sim.Close()
		if _, err := sim.ConnectPNG(&niimblue.PNGPrinterOptions{Model: model}); err != nil {
			return testPrintedMsg{err: err}
		}
		res, err := sim.PrintTemplate(tmpl, []map[string]string{data}, &niimblue.TemplatePrintOptions{StatusPollIntervalMs: 5})
		if err != nil {
			return testPrintedMsg{err: err}
		}
		pages, err := sim.PNGPages(res.JobID)
		if err != nil {
			return testPrintedMsg{err: err}
		}
		if len(pages) == 0 {
			return testPrintedMsg{err: fmt.Errorf("PNG printer printed no page")}
		}
		if err := os.WriteFile(path, pages[0].PNG, 0o644); err != nil {
			return testPrintedMsg{err: err}
		}
		return testPrintedMsg{path: path, width: pages[0].Width, height: pages[0].Height}
	}
}

func printCmd(p *niimblue.Printer, tmpl []byte, data map[string]string, copies int) tea.Cmd {
	return func() tea.Msg {
		res, err := p.PrintTemplate(tmpl, []map[string]string{data}, &niimblue.TemplatePrintOptions{Quantity: copies})
		return printedMsg{res, err}
	}
}

// previewFailedMsg: the test print was written but the image viewer could not be started.
type previewFailedMsg struct {
	path string
	err  error
}

// openPreviewCmd opens a test print PNG in the system's default image viewer
// (open on macOS, xdg-open on Linux / BSD, the associated app on Windows).
// The viewer runs on its own; niimtui does not wait for it to close.
func openPreviewCmd(path string) tea.Cmd {
	return func() tea.Msg {
		var cmd *exec.Cmd
		switch runtime.GOOS {
		case "darwin":
			cmd = exec.Command("open", path)
		case "windows":
			cmd = exec.Command("rundll32", "url.dll,FileProtocolHandler", path)
		default:
			cmd = exec.Command("xdg-open", path)
		}
		// Keep the viewer's output off the TUI.
		cmd.Stdin, cmd.Stdout, cmd.Stderr = nil, nil, nil
		if err := cmd.Start(); err != nil {
			return previewFailedMsg{path: path, err: err}
		}
		go func() { _ = cmd.Wait() }() // reap the launcher process
		return nil
	}
}

// testPrintPath is where a test print is written: <template name>-test.png in outDir.
func testPrintPath(outDir, templatePath string) string {
	base := strings.TrimSuffix(filepath.Base(templatePath), ".niim")
	return filepath.Join(outDir, base+"-test.png")
}

func parseCopies(s string) (int, error) {
	n, err := strconv.Atoi(strings.TrimSpace(s))
	if err != nil || n < 1 || n > 100 {
		return 0, fmt.Errorf("copies must be 1-100")
	}
	return n, nil
}

/* ---- print orientation ---- */

// orientationShort names a niimbluelib printDirection the way people see the
// label come out: "top" prints the design as drawn (horizontal), "left"
// rotates it 90° before printing (vertical, typical for narrow tape).
func orientationShort(direction string) string {
	switch direction {
	case "top":
		return "horizontal"
	case "left":
		return "vertical"
	}
	return "in an unknown direction (" + direction + ")"
}

func orientation(direction string) string {
	switch direction {
	case "top":
		return "horizontal (as designed, top edge first)"
	case "left":
		return "vertical (rotated 90° when printing)"
	}
	return orientationShort(direction)
}

// orientationWarning reports a template whose print direction does not match
// the connected printer: it would come out rotated and cut off.
func (m model) orientationWarning() string {
	if !m.connected || m.info == nil || m.info.ModelMetadata == nil || m.tmpl == nil {
		return ""
	}
	want := m.info.ModelMetadata.PrintDirection
	if want == "" || want == m.tmplInfo.direction {
		return ""
	}
	return fmt.Sprintf("%s prints %s labels: this template would print rotated",
		m.info.ModelMetadata.Model, orientationShort(want))
}
