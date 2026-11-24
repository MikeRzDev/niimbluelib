package main

import (
	"path/filepath"
	"strings"
	"testing"
)

// update feeds msg to the model like the bubbletea loop does.
func update(t *testing.T, m model, msg any) model {
	t.Helper()
	next, _ := m.Update(msg)
	nm, ok := next.(model)
	if !ok {
		t.Fatalf("Update returned %T", next)
	}
	return nm
}

// TestModelPrintFlow drives the UI the way a user does: open the template,
// fill the form, test print, connect the virtual B1 and print.
func TestModelPrintFlow(t *testing.T) {
	p := newPrinter(t)
	outDir := t.TempDir()
	m := newModel(p, "testdata", assetTag, outDir, false)

	m = update(t, m, loadTemplateCmd(p, assetTag)())
	if m.tmpl == nil || m.tab != tabLabel || m.statusErr {
		t.Fatalf("after load: tab %d, status %q", m.tab, m.status)
	}
	values := map[string]string{"asset_name": "Oppenheimer", "asset_type": "Compute Node", "site": "Manhattan"}
	for i := range m.fields {
		if v, ok := values[m.fields[i].name]; ok {
			m.fields[i].input.SetValue(v)
		}
	}
	firstUUID := formData(m.fields)["uuid"]

	// Test print through the PNG printer
	cmd := m.testPrint()
	if cmd == nil || !m.testing {
		t.Fatal("test print did not start")
	}
	m = update(t, m, cmd())
	if m.statusErr || m.lastTest != filepath.Join(outDir, "label_1794197090-test.png") {
		t.Fatalf("test print: lastTest %q, status %q", m.lastTest, m.status)
	}

	// Printing needs a connection
	if m.print() != nil || !strings.Contains(m.status, "Connect a printer") {
		t.Errorf("print without printer: %q", m.status)
	}
	m = update(t, m, connectCmd(p, device{kind: devVirtual, name: "Virtual B1"})())
	if !m.connected {
		t.Fatalf("virtual printer not connected: %q", m.status)
	}
	if w := m.orientationWarning(); w != "" {
		t.Errorf("orientation warning for a B1 template: %s", w)
	}

	cmd = m.print()
	if cmd == nil {
		t.Fatalf("print did not start: %q", m.status)
	}
	m = update(t, m, cmd())
	if m.statusErr || !strings.Contains(m.status, "Printed 1 page(s) (B1)") {
		t.Fatalf("print: %q", m.status)
	}
	// The next label gets a fresh UUID
	if next := formData(m.fields)["uuid"]; next == firstUUID || len(next) != 36 {
		t.Errorf("uuid after print = %q (was %q)", next, firstUUID)
	}

	// A template for the other print direction is flagged
	m.tmplInfo.direction = "left"
	if w := m.orientationWarning(); !strings.Contains(w, "would print rotated") {
		t.Errorf("orientation warning = %q", w)
	}
}

func TestModelLoadError(t *testing.T) {
	p := newPrinter(t)
	m := newModel(p, ".", "", t.TempDir(), false)
	m = update(t, m, loadTemplateCmd(p, filepath.Join(t.TempDir(), "missing.niim"))())
	if !m.statusErr || !m.picking || m.tmpl != nil {
		t.Errorf("after failed load: statusErr %v, picking %v, status %q", m.statusErr, m.picking, m.status)
	}
	if m.testPrint() != nil {
		t.Error("test print without a template started")
	}
}
