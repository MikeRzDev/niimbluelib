// niimtui is a terminal UI for NIIMBOT label printers built on the niimblue
// Go bindings: connect over USB serial or Bluetooth LE (or a simulated B1),
// watch the printer status, fill a label template (.niim, e.g. exported
// from the NiimBlue editor), test print it to a PNG and print it.
//
//	go run .                                   (pick a template in the app)
//	go run . -template testdata/label_1794197090.niim
//	go run . -dir ~/labels -out /tmp           (picker start dir, test print dir)
//	go run . -preview=false                    (don't open test prints in an image viewer)
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"path/filepath"

	tea "charm.land/bubbletea/v2"
	niimblue "github.com/MultiMote/niimbluelib/native/go"
)

func main() {
	var (
		tmpl = flag.String("template", "", "template to open at start (.niim)")
		dir  = flag.String("dir", ".", "directory the template picker starts in")
		out  = flag.String("out", ".", "directory for test print PNGs")
		prev = flag.Bool("preview", true, "open each test print in the system image viewer")
	)
	flag.Parse()

	startDir, err := filepath.Abs(*dir)
	if err != nil {
		fail(err)
	}
	if *tmpl != "" {
		if *tmpl, err = filepath.Abs(*tmpl); err != nil {
			fail(err)
		}
		startDir = filepath.Dir(*tmpl)
	}

	p, err := niimblue.New()
	if err != nil {
		fail(err)
	}
	defer p.Close()

	prog := tea.NewProgram(newModel(p, startDir, *tmpl, *out, *prev))

	// Library events arrive on its own thread; hand them to the UI loop.
	p.OnEvent(func(name string, payload json.RawMessage) {
		prog.Send(eventMsg{name: name, payload: append(json.RawMessage(nil), payload...)})
	})

	final, err := prog.Run()
	p.OnEvent(nil)
	if m, ok := final.(model); ok && m.connected {
		_ = p.Disconnect()
		if m.link != nil {
			m.link.close()
		}
	}
	if err != nil {
		fail(err)
	}
}

func fail(err error) {
	fmt.Fprintln(os.Stderr, "niimtui:", err)
	os.Exit(1)
}
