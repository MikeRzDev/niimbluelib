package niimblue

import (
	"os/exec"
	"slices"
	"testing"
)

// The generated wrappers (zz_api*.go and the other bindings) must match api/api.json
// and api/api.json must list every js/bridge.ts method.
func TestAPIGeneratedInSync(t *testing.T) {
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("node not installed")
	}
	cmd := exec.Command(node, "api/generate.mjs", "--check")
	cmd.Dir = ".."
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("generated API is stale: %v\n%s", err, out)
	}
}

// Generated methods without a printer: static lists, queue control, binary payloads.
func TestGeneratedMethods(t *testing.T) {
	p := newPrinter(t)

	tasks, err := p.PrintTasks()
	if err != nil || !slices.Contains(tasks, "B1") {
		t.Errorf("PrintTasks = %v %v", tasks, err)
	}
	models, err := p.Models()
	if err != nil || len(models) == 0 {
		t.Errorf("Models = %d %v", len(models), err)
	}

	if paused, err := p.QueuePaused(); err != nil || paused {
		t.Errorf("QueuePaused = %v %v", paused, err)
	}
	if err := p.PauseQueue(); err != nil {
		t.Fatal(err)
	}
	if paused, _ := p.QueuePaused(); !paused {
		t.Error("queue not paused")
	}
	if err := p.ResumeQueue(); err != nil {
		t.Fatal(err)
	}
	if n, err := p.ClearQueue(); err != nil || n != 0 {
		t.Errorf("ClearQueue = %d %v", n, err)
	}

	// Not connected: methods needing a printer fail with the library error
	if _, err := p.PrinterInfo(); err == nil {
		t.Error("PrinterInfo without printer succeeded")
	}
	if err := p.SetHeartbeatInterval(1000); err == nil {
		t.Error("SetHeartbeatInterval without printer succeeded")
	}

	// Binary payload through niim_call_bin, and a missing one
	if _, err := p.RegisterFont("Junk", []byte("not a font"), 0, false); err == nil {
		t.Error("junk font accepted")
	}
	if _, err := p.RegisterFont("Empty", nil, 0, false); err == nil {
		t.Error("missing font data accepted")
	}
}
