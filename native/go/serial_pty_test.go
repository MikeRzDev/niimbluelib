//go:build !windows

package niimblue

import (
	"os"
	"testing"
	"time"

	"github.com/creack/pty"
)

// Exercises the real serial transport (termios, reader thread) against a fake
// printer on the master side of a pseudo terminal.
func TestSerialOverPTY(t *testing.T) {
	master, slave, err := pty.Open()
	if err != nil {
		t.Skipf("no pty: %v", err)
	}
	defer master.Close()
	slavePath := slave.Name()
	slave.Close() // the library opens it by path

	fp := newFakePrinter(t, b1Dump)
	stop := make(chan struct{})
	done := make(chan struct{})
	go func() {
		defer close(done)
		serveFakePrinter(master, fp, stop)
	}()
	defer func() { close(stop); master.SetReadDeadline(time.Now()); <-done }()

	p := newPrinter(t)
	ev := recordEvents(t, p)

	info, err := p.ConnectSerial(slavePath, noHeartbeat)
	if err != nil {
		t.Fatalf("connect over %s: %v", slavePath, err)
	}
	if info.PrintTask != "B1" {
		t.Errorf("task %q", info.PrintTask)
	}
	if _, err := p.Print(testImage(), fastPoll); err != nil {
		t.Fatal(err)
	}

	// Multi page job over the real serial transport
	batch, err := p.PrintBatch([]Page{
		{Image: solidImage(48, 24), Quantity: 2},
		{Image: testImage(), PrintDirection: "left"},
	}, fastPoll)
	if err != nil {
		t.Fatal(err)
	}
	if batch.Pages != 3 || len(batch.Images) != 2 {
		t.Errorf("batch result %+v", batch)
	}
	checkJobsContiguous(t, fp)

	if err := p.Disconnect(); err != nil {
		t.Fatal(err)
	}
	if ev.count("printend") != 2 || ev.count("disconnect") != 1 {
		t.Errorf("events %v", ev.counts)
	}
	if n := fp.requestCount(); n < 15 {
		t.Errorf("fake printer saw only %d frames", n)
	}
}

func serveFakePrinter(f *os.File, fp *fakePrinter, stop chan struct{}) {
	var buf []byte
	chunk := make([]byte, 4096)
	for {
		select {
		case <-stop:
			return
		default:
		}
		_ = f.SetReadDeadline(time.Now().Add(50 * time.Millisecond))
		n, err := f.Read(chunk)
		if n > 0 {
			buf = append(buf, chunk[:n]...)
			var frames [][]byte
			frames, buf = splitFrames(buf)
			for _, fr := range frames {
				if resp := fp.respond(fr); resp != nil {
					_, _ = f.Write(resp)
				}
			}
		}
		if err != nil && !os.IsTimeout(err) {
			select {
			case <-stop:
				return
			case <-time.After(10 * time.Millisecond):
			}
		}
	}
}
