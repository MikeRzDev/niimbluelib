package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"path/filepath"
	"strings"
	"time"

	"charm.land/bubbles/v2/filepicker"
	"charm.land/bubbles/v2/spinner"
	"charm.land/bubbles/v2/textinput"
	tea "charm.land/bubbletea/v2"
	"charm.land/lipgloss/v2"
	niimblue "github.com/MultiMote/niimbluelib/native/go"
	"github.com/google/uuid"
)

const (
	tabPrinter = iota
	tabLabel
	tabLog
)

var tabNames = []string{"Printer", "Label", "Log"}

var (
	accent    = lipgloss.Color("#7D56F4")
	okColor   = lipgloss.Color("#3FB950")
	warnColor = lipgloss.Color("#D29922")
	errColor  = lipgloss.Color("#F85149")
	dimColor  = lipgloss.Color("#8B949E")

	titleStyle     = lipgloss.NewStyle().Bold(true).Foreground(accent)
	tabStyle       = lipgloss.NewStyle().Padding(0, 1).Foreground(dimColor)
	activeTabStyle = lipgloss.NewStyle().Padding(0, 1).Bold(true).Foreground(lipgloss.Color("#FFFFFF")).Background(accent)
	dimStyle       = lipgloss.NewStyle().Foreground(dimColor)
	okStyle        = lipgloss.NewStyle().Foreground(okColor)
	warnStyle      = lipgloss.NewStyle().Foreground(warnColor)
	errStyle       = lipgloss.NewStyle().Foreground(errColor)
	headStyle      = lipgloss.NewStyle().Bold(true).Underline(true)
	selStyle       = lipgloss.NewStyle().Bold(true).Foreground(accent)
)

type model struct {
	p       *niimblue.Printer
	outDir  string
	preview bool // open each test print in the system image viewer

	width, height int
	tab           int
	spin          spinner.Model
	busy          string // operation in progress, shown with the spinner
	status        string
	statusErr     bool
	log           []string

	// printer tab
	ports     []string
	bleDevs   []bleDevice
	scanning  bool
	sel       int
	connected bool
	dev       device
	link      *bleLink
	info      *niimblue.ConnectionInfo
	hb        *niimblue.HeartbeatData
	hbAt      time.Time
	rfid      *rfidSummary
	progress  string

	// label tab
	picker   filepicker.Model
	picking  bool
	tmplPath string
	tmpl     []byte
	tmplInfo labelInfo
	fields   []field
	copies   textinput.Model
	focus    int // index into fields; len(fields) is the copies input
	editing  bool
	testing  bool
	lastTest string // PNG written by the last test print
	testErr  string
	printing bool
}

func newModel(p *niimblue.Printer, startDir, templatePath, outDir string, preview bool) model {
	fp := filepicker.New()
	fp.CurrentDirectory = startDir
	fp.AllowedTypes = []string{".niim"}
	fp.AutoHeight = false
	fp.SetHeight(14)

	m := model{
		p:       p,
		outDir:  outDir,
		preview: preview,
		spin:    spinner.New(spinner.WithSpinner(spinner.Dot)),
		picker:  fp,
		picking: templatePath == "",
		copies:  newCopiesInput(),
	}
	m.tmplPath = templatePath
	return m
}

func (m model) Init() tea.Cmd {
	cmds := []tea.Cmd{listPortsCmd(), m.picker.Init(), m.spin.Tick}
	if m.tmplPath != "" {
		cmds = append(cmds, loadTemplateCmd(m.p, m.tmplPath))
	}
	return tea.Batch(cmds...)
}

/* ---- helpers ---- */

func (m *model) setStatus(s string, isErr bool) {
	m.status, m.statusErr = s, isErr
	m.addLog(s)
}

func (m *model) addLog(s string) {
	m.log = append(m.log, time.Now().Format("15:04:05")+"  "+s)
	if len(m.log) > 500 {
		m.log = m.log[len(m.log)-500:]
	}
}

func (m model) devices() []device {
	devs := make([]device, 0, len(m.ports)+len(m.bleDevs)+1)
	for _, p := range m.ports {
		devs = append(devs, device{kind: devSerial, name: p})
	}
	for _, b := range m.bleDevs {
		devs = append(devs, device{kind: devBLE, name: b.Name, ble: b})
	}
	return append(devs, device{kind: devVirtual, name: "Virtual B1"})
}

func errText(err error) string {
	var e *niimblue.Error
	if errors.As(err, &e) {
		return e.Message
	}
	return err.Error()
}

// focusField moves the form focus, blurring the previous input.
func (m *model) focusField(i int) tea.Cmd {
	n := len(m.fields) + 1
	m.focus = (i%n + n) % n
	for j := range m.fields {
		m.fields[j].input.Blur()
	}
	m.copies.Blur()
	if !m.editing {
		return nil
	}
	if m.focus == len(m.fields) {
		return m.copies.Focus()
	}
	return m.fields[m.focus].input.Focus()
}

func (m *model) testPrint() tea.Cmd {
	if m.tmpl == nil || m.testing {
		return nil
	}
	m.testing = true
	m.busy = "Test print (PNG)"
	return testPrintCmd(m.p, m.tmpl, formData(m.fields), testPrintPath(m.outDir, m.tmplPath))
}

func (m *model) print() tea.Cmd {
	switch {
	case m.tmpl == nil:
		m.setStatus("Open a template first", true)
		return nil
	case !m.connected:
		m.setStatus("Connect a printer first (Printer tab)", true)
		return nil
	case m.printing:
		return nil
	}
	copies, err := parseCopies(m.copies.Value())
	if err != nil {
		m.setStatus(err.Error(), true)
		return nil
	}
	m.printing = true
	m.progress = ""
	m.busy = fmt.Sprintf("Printing %d label(s)", copies)
	m.addLog(fmt.Sprintf("print %s x%d %v", filepath.Base(m.tmplPath), copies, formData(m.fields)))
	return printCmd(m.p, m.tmpl, formData(m.fields), copies)
}

func (m *model) generateUUID() tea.Cmd {
	if m.focus < len(m.fields) {
		m.fields[m.focus].input.SetValue(uuid.NewString())
	}
	return nil
}

/* ---- update ---- */

func (m model) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		m.width, m.height = msg.Width, msg.Height
		m.picker.SetHeight(max(5, m.height-10))
		return m, nil

	case spinner.TickMsg:
		var cmd tea.Cmd
		m.spin, cmd = m.spin.Update(msg)
		return m, cmd

	case tea.KeyPressMsg:
		return m.handleKey(msg)

	case portsMsg:
		if msg.err != nil {
			m.setStatus("Serial ports: "+msg.err.Error(), true)
		}
		m.ports = msg.ports
		m.sel = min(m.sel, len(m.devices())-1)
		return m, nil

	case scanMsg:
		m.scanning = false
		m.busy = ""
		if msg.err != nil {
			m.setStatus("Bluetooth: "+msg.err.Error(), true)
			return m, nil
		}
		m.bleDevs = msg.devs
		m.setStatus(fmt.Sprintf("Bluetooth scan found %d printer(s)", len(msg.devs)), false)
		return m, nil

	case connectedMsg:
		m.busy = ""
		if msg.err != nil {
			m.connected = false
			m.setStatus("Connect failed: "+errText(msg.err), true)
			return m, nil
		}
		m.connected, m.dev, m.info, m.link = true, msg.dev, msg.info, msg.link
		m.hb, m.rfid, m.hbAt = nil, nil, time.Time{}
		name := "unknown model"
		if msg.info.ModelMetadata != nil {
			name = msg.info.ModelMetadata.Model
		}
		m.setStatus(fmt.Sprintf("Connected to %s (%s)", msg.dev.label(), name), false)
		return m, statusCmd(m.p)

	case disconnectedMsg:
		m.busy = ""
		m.connected, m.link, m.info, m.hb, m.rfid = false, nil, nil, nil, nil
		if msg.err != nil {
			m.setStatus("Disconnect: "+errText(msg.err), true)
		} else {
			m.setStatus("Disconnected", false)
		}
		return m, nil

	case statusMsg:
		m.busy = ""
		if msg.err != nil {
			m.setStatus("Status: "+errText(msg.err), true)
			return m, nil
		}
		m.hb, m.hbAt = msg.hb, time.Now()
		if msg.rfid != nil {
			m.rfid = msg.rfid
		}
		return m, nil

	case eventMsg:
		return m.handleEvent(msg)

	case templateLoadedMsg:
		m.busy = ""
		if msg.err != nil {
			m.setStatus("Template: "+msg.err.Error(), true)
			m.picking = true
			return m, nil
		}
		m.tmplPath, m.tmpl, m.tmplInfo, m.fields = msg.path, msg.data, msg.info, msg.fields
		m.picking, m.lastTest, m.testErr = false, "", ""
		m.editing = true
		m.tab = tabLabel
		m.setStatus(fmt.Sprintf("Loaded %s (%d fields)", filepath.Base(msg.path), len(msg.fields)), false)
		return m, m.focusField(0)

	case testPrintedMsg:
		m.testing, m.busy = false, ""
		if msg.err != nil {
			m.lastTest, m.testErr = "", errText(msg.err)
			m.setStatus("Test print failed: "+m.testErr, true)
			return m, nil
		}
		m.lastTest, m.testErr = msg.path, ""
		m.setStatus(fmt.Sprintf("Test print written to %s (%d×%d)", msg.path, msg.width, msg.height), false)
		if m.preview {
			return m, openPreviewCmd(msg.path)
		}
		return m, nil

	case previewFailedMsg:
		m.setStatus("Test print written to "+msg.path+", but the preview did not open: "+errText(msg.err), true)
		return m, nil

	case printedMsg:
		m.printing, m.busy = false, ""
		if msg.err != nil {
			m.setStatus("Print failed: "+errText(msg.err), true)
			return m, nil
		}
		m.progress = ""
		m.setStatus(fmt.Sprintf("Printed %d page(s) (%s)", msg.res.Pages, msg.res.PrintTask), false)
		// next label gets a fresh UUID
		for i := range m.fields {
			if isUUIDField(m.fields[i].name) {
				m.fields[i].input.SetValue(uuid.NewString())
			}
		}
		return m, statusCmd(m.p)
	}

	// file picker messages (directory reads)
	if m.picking {
		return m.updatePicker(msg)
	}
	return m, nil
}

func (m model) handleEvent(e eventMsg) (tea.Model, tea.Cmd) {
	switch e.name {
	case "heartbeat":
		var ev struct {
			Data niimblue.HeartbeatData `json:"data"`
		}
		if json.Unmarshal(e.payload, &ev) == nil {
			m.hb, m.hbAt = &ev.Data, time.Now()
		}
	case "heartbeatfailed":
		m.addLog("heartbeat failed: " + string(e.payload))
	case "disconnect":
		if m.connected {
			m.connected = false
			m.setStatus("Printer disconnected", true)
		}
	case "printprogress":
		var pr niimblue.PrintProgress
		if json.Unmarshal(e.payload, &pr) == nil {
			m.progress = fmt.Sprintf("page %d/%d  print %d%%  feed %d%%", pr.Page, pr.PagesTotal, pr.PagePrintProgress, pr.PageFeedProgress)
		}
	case "printpacketprogress":
		// one per image packet, too noisy for the log
	case "log":
		var l struct {
			Level   string `json:"level"`
			Message string `json:"message"`
		}
		if json.Unmarshal(e.payload, &l) == nil {
			m.addLog("[" + l.Level + "] " + l.Message)
		}
	default:
		m.addLog(e.name)
	}
	return m, nil
}

func (m model) updatePicker(msg tea.Msg) (tea.Model, tea.Cmd) {
	var cmd tea.Cmd
	m.picker, cmd = m.picker.Update(msg)
	if ok, path := m.picker.DidSelectFile(msg); ok {
		m.busy = "Loading template"
		return m, tea.Batch(cmd, loadTemplateCmd(m.p, path))
	}
	return m, cmd
}

func (m model) handleKey(k tea.KeyPressMsg) (tea.Model, tea.Cmd) {
	key := k.String()
	if key == "ctrl+c" {
		return m, tea.Quit
	}

	// Typing in the form: only a few control keys are taken
	if m.tab == tabLabel && m.editing && !m.picking {
		switch key {
		case "esc":
			m.editing = false
			return m, m.focusField(m.focus)
		case "tab", "down", "enter":
			return m, m.focusField(m.focus + 1)
		case "shift+tab", "up":
			return m, m.focusField(m.focus - 1)
		case "ctrl+g":
			return m, m.generateUUID()
		case "ctrl+t":
			return m, m.testPrint()
		case "ctrl+p":
			return m, m.print()
		case "ctrl+o":
			m.picking, m.editing = true, false
			return m, m.picker.Init()
		}
		var cmd tea.Cmd
		if m.focus == len(m.fields) {
			m.copies, cmd = m.copies.Update(k)
			return m, cmd
		}
		m.fields[m.focus].input, cmd = m.fields[m.focus].input.Update(k)
		return m, cmd
	}

	// Global navigation
	switch key {
	case "q":
		return m, tea.Quit
	case "1", "2", "3":
		m.tab = int(key[0] - '1')
		return m, nil
	case "right", "l":
		if !(m.tab == tabLabel && m.picking) {
			m.tab = (m.tab + 1) % len(tabNames)
			return m, nil
		}
	case "left":
		if !(m.tab == tabLabel && m.picking) {
			m.tab = (m.tab + len(tabNames) - 1) % len(tabNames)
			return m, nil
		}
	}

	switch m.tab {
	case tabPrinter:
		return m.printerKey(key)
	case tabLabel:
		if m.picking {
			if key == "esc" && m.tmpl != nil && m.picker.CurrentDirectory == filepath.Dir(m.tmplPath) {
				m.picking = false
				return m, nil
			}
			if key == "tab" && m.tmpl != nil {
				m.picking = false
				return m, nil
			}
			return m.updatePicker(k)
		}
		return m.labelKey(key)
	}
	return m, nil
}

func (m model) printerKey(key string) (tea.Model, tea.Cmd) {
	devs := m.devices()
	switch key {
	case "up", "k":
		m.sel = max(0, m.sel-1)
	case "down", "j":
		m.sel = min(len(devs)-1, m.sel+1)
	case "enter", "c":
		if m.busy != "" {
			return m, nil
		}
		d := devs[m.sel]
		m.busy = "Connecting to " + d.label()
		m.addLog(m.busy)
		var cmds []tea.Cmd
		if m.connected && m.link != nil {
			// close the previous Bluetooth link first
			cmds = append(cmds, disconnectCmd(m.p, m.link))
			m.link = nil
		}
		return m, tea.Sequence(append(cmds, connectCmd(m.p, d))...)
	case "d":
		if !m.connected || m.busy != "" {
			return m, nil
		}
		m.busy = "Disconnecting"
		return m, disconnectCmd(m.p, m.link)
	case "s":
		if m.scanning {
			return m, nil
		}
		m.scanning = true
		m.busy = "Scanning Bluetooth (5 s)"
		return m, scanCmd(5 * time.Second)
	case "p":
		return m, listPortsCmd()
	case "r":
		if !m.connected {
			return m, nil
		}
		m.busy = "Reading status"
		return m, statusCmd(m.p)
	}
	return m, nil
}

func (m model) labelKey(key string) (tea.Model, tea.Cmd) {
	switch key {
	case "o":
		m.picking = true
		return m, m.picker.Init()
	case "e", "enter":
		if m.tmpl != nil {
			m.editing = true
			return m, m.focusField(m.focus)
		}
	case "up", "k":
		return m, m.focusField(m.focus - 1)
	case "down", "j", "tab":
		return m, m.focusField(m.focus + 1)
	case "g":
		return m, m.generateUUID()
	case "t":
		return m, m.testPrint()
	case "p":
		return m, m.print()
	}
	return m, nil
}

/* ---- view ---- */

func (m model) View() tea.View {
	if m.width == 0 {
		return tea.NewView("")
	}
	header := m.headerView()
	footer := m.footerView()
	bodyH := max(5, m.height-lipgloss.Height(header)-lipgloss.Height(footer))

	var body string
	switch m.tab {
	case tabPrinter:
		body = m.printerView()
	case tabLabel:
		body = m.labelView()
	case tabLog:
		body = m.logView(bodyH)
	}
	body = lipgloss.NewStyle().Height(bodyH).MaxHeight(bodyH).Render(body)

	v := tea.NewView(lipgloss.JoinVertical(lipgloss.Left, header, body, footer))
	v.AltScreen = true
	return v
}

func (m model) headerView() string {
	tabs := []string{titleStyle.Render("niimtui") + "  "}
	for i, n := range tabNames {
		s := fmt.Sprintf("%d %s", i+1, n)
		if i == m.tab {
			tabs = append(tabs, activeTabStyle.Render(s))
		} else {
			tabs = append(tabs, tabStyle.Render(s))
		}
	}
	left := lipgloss.JoinHorizontal(lipgloss.Top, tabs...)

	conn := errStyle.Render("● disconnected")
	if m.connected {
		name := m.dev.label()
		if m.info != nil && m.info.ModelMetadata != nil {
			name = m.info.ModelMetadata.Model + " · " + name
		}
		conn = okStyle.Render("● " + name)
		if m.hb != nil && m.hb.BatteryPercents != nil {
			conn += dimStyle.Render(fmt.Sprintf("  %d%%", *m.hb.BatteryPercents))
		}
	}
	gap := max(1, m.width-lipgloss.Width(left)-lipgloss.Width(conn)-1)
	line := left + strings.Repeat(" ", gap) + conn
	return line + "\n" + dimStyle.Render(strings.Repeat("─", m.width))
}

func (m model) footerView() string {
	var status string
	switch {
	case m.busy != "":
		status = m.spin.View() + " " + m.busy + "…"
		if m.printing && m.progress != "" {
			status += "  " + m.progress
		}
	case m.statusErr:
		status = errStyle.Render(m.status)
	default:
		status = m.status
	}

	var help string
	switch {
	case m.tab == tabPrinter:
		help = "↑↓ select · enter connect · d disconnect · r status · s scan BLE · p ports · 1-3 tabs · q quit"
	case m.tab == tabLabel && m.picking:
		help = "↑↓ move · → open dir · ← up · enter choose" + map[bool]string{true: " · tab back to form", false: ""}[m.tmpl != nil] + " · ctrl+c quit"
	case m.tab == tabLabel && m.editing:
		help = "tab/↑↓ field · ctrl+g new UUID · ctrl+t test print → PNG · ctrl+p print · ctrl+o open · esc done"
	case m.tab == tabLabel:
		help = "e edit · g new UUID · t test print → PNG · p print · o open template · 1-3 tabs · q quit"
	default:
		help = "1-3 tabs · q quit"
	}
	return dimStyle.Render(strings.Repeat("─", m.width)) + "\n" +
		lipgloss.NewStyle().MaxWidth(m.width).Render(status) + "\n" +
		dimStyle.MaxWidth(m.width).Render(help)
}

func (m model) printerView() string {
	devs := m.devices()
	var b strings.Builder
	b.WriteString(headStyle.Render("Devices") + "\n\n")
	lastKind := deviceKind(-1)
	for i, d := range devs {
		if d.kind != lastKind {
			lastKind = d.kind
			switch d.kind {
			case devSerial:
				b.WriteString(dimStyle.Render("USB serial") + "\n")
			case devBLE:
				b.WriteString(dimStyle.Render("Bluetooth") + "\n")
			case devVirtual:
				if len(m.bleDevs) == 0 {
					b.WriteString(dimStyle.Render("Bluetooth  (s to scan)") + "\n\n")
				}
				b.WriteString(dimStyle.Render("Test") + "\n")
			}
		}
		line := "  " + d.label()
		if m.connected && d.kind == m.dev.kind && d.name == m.dev.name {
			line += okStyle.Render("  ●")
		}
		if i == m.sel {
			line = selStyle.Render("› " + strings.TrimPrefix(line, "  "))
		}
		b.WriteString(line + "\n")
		if i+1 < len(devs) && devs[i+1].kind != d.kind {
			b.WriteString("\n")
		}
	}
	if len(m.ports) == 0 {
		b.WriteString("\n" + dimStyle.Render("No USB serial ports (p to refresh)"))
	}
	left := lipgloss.NewStyle().Width(42).Render(b.String())

	var s strings.Builder
	s.WriteString(headStyle.Render("Status") + "\n\n")
	for _, r := range m.statusRows() {
		v := r[1]
		switch {
		case v == "OPEN" || v == "MISSING":
			v = warnStyle.Render(v)
		case r[0] == "State" && v == "connected":
			v = okStyle.Render(v)
		}
		s.WriteString(dimStyle.Render(fmt.Sprintf("%-11s", r[0])) + " " + v + "\n")
	}
	return lipgloss.JoinHorizontal(lipgloss.Top, left, "  ", s.String())
}

func (m model) labelView() string {
	if m.picking {
		title := headStyle.Render("Open template (.niim)") + "\n" + dimStyle.Render(m.picker.CurrentDirectory) + "\n\n"
		return title + m.picker.View()
	}
	if m.tmpl == nil {
		return dimStyle.Render("No template loaded. Press o to open one.")
	}

	// Form
	var f strings.Builder
	if m.tmplInfo.title != "" {
		f.WriteString(headStyle.Render("Template") + " " + m.tmplInfo.title + "\n")
		f.WriteString(dimStyle.Render(filepath.Base(m.tmplPath)) + "\n")
	} else {
		f.WriteString(headStyle.Render("Template") + " " + filepath.Base(m.tmplPath) + "\n")
	}
	if i := m.tmplInfo; i.width > 0 && i.dpmm > 0 {
		f.WriteString(dimStyle.Render(fmt.Sprintf("%.0f×%.0f mm · %d×%d dots",
			float64(i.width)/i.dpmm, float64(i.height)/i.dpmm, i.width, i.height)) + "\n")
		f.WriteString("Prints " + orientation(i.direction) + "\n")
		if w := m.orientationWarning(); w != "" {
			f.WriteString(warnStyle.Render("⚠ "+w) + "\n")
		}
	}
	f.WriteString("\n")
	labelW := 12
	for _, fl := range m.fields {
		labelW = max(labelW, len(fl.name)+2)
	}
	row := func(i int, label string, input string) {
		marker := "  "
		st := lipgloss.NewStyle()
		if i == m.focus {
			marker = selStyle.Render("› ")
			st = selStyle
		}
		f.WriteString(marker + st.Render(fmt.Sprintf("%-*s", labelW, label)) + input + "\n")
	}
	for i, fl := range m.fields {
		label := fl.name
		if fl.required {
			label += "*"
		}
		row(i, label, fl.input.View())
	}
	f.WriteString("\n")
	row(len(m.fields), "copies", m.copies.View())
	f.WriteString("\n" + dimStyle.Render("* required"))
	if len(m.fields) > 0 && m.focus < len(m.fields) && m.fields[m.focus].description != "" {
		f.WriteString("\n\n" + dimStyle.Render(m.fields[m.focus].description))
	}
	form := lipgloss.NewStyle().Width(max(40, labelW+40)).Render(f.String())

	// Test print result (the PNG itself is not shown here)
	w := max(20, m.width-lipgloss.Width(form)-4)
	wrap := lipgloss.NewStyle().Width(w)
	var t strings.Builder
	t.WriteString(headStyle.Render("Test print") + "\n\n")
	switch {
	case m.testErr != "":
		t.WriteString(errStyle.Width(w).Render(m.testErr))
	case m.lastTest != "":
		t.WriteString(okStyle.Render("PNG written") + "\n" + wrap.Render(m.lastTest))
	default:
		t.WriteString(dimStyle.Render("t / ctrl+t renders the label without a printer\nand writes it to") + "\n" +
			wrap.Render(testPrintPath(m.outDir, m.tmplPath)))
	}
	return lipgloss.JoinHorizontal(lipgloss.Top, form, "  ", t.String())
}

func (m model) logView(h int) string {
	lines := m.log
	if len(lines) > h {
		lines = lines[len(lines)-h:]
	}
	if len(lines) == 0 {
		return dimStyle.Render("No events yet.")
	}
	return lipgloss.NewStyle().MaxWidth(m.width).Render(strings.Join(lines, "\n"))
}
