package niimblue

import (
	"encoding/json"
	"errors"
	"image"
	"image/color"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

var noHeartbeat = &ConnectOptions{Heartbeat: Bool(false)}

func newPrinter(t *testing.T) *Printer {
	t.Helper()
	p, err := New()
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	t.Cleanup(p.Close)
	return p
}

// eventLog records events and fails the test on error level logs.
type eventLog struct {
	t      *testing.T
	mu     sync.Mutex
	counts map[string]int
	last   map[string]json.RawMessage
}

func recordEvents(t *testing.T, p *Printer) *eventLog {
	l := &eventLog{t: t, counts: map[string]int{}, last: map[string]json.RawMessage{}}
	p.OnEvent(func(name string, payload json.RawMessage) {
		l.mu.Lock()
		defer l.mu.Unlock()
		l.counts[name]++
		l.last[name] = payload
		if name == "log" && strings.Contains(string(payload), `"level":"error"`) {
			t.Errorf("error log: %s", payload)
		}
	})
	return l
}

func (l *eventLog) count(name string) int {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.counts[name]
}

// testImage: 120x64 checkerboard with a white border.
func testImage() *image.Gray {
	img := image.NewGray(image.Rect(0, 0, 120, 64))
	for y := 0; y < 64; y++ {
		for x := 0; x < 120; x++ {
			c := uint8(255)
			if x >= 4 && x < 116 && y >= 4 && y < 60 && (x/8+y/8)%2 == 0 {
				c = 0
			}
			img.SetGray(x, y, color.Gray{Y: c})
		}
	}
	return img
}

var fastPoll = &PrintOptions{Quantity: 1, Density: 3, StatusPollIntervalMs: 20}

func TestVersions(t *testing.T) {
	if Version() != "0.1.0" {
		t.Errorf("Version = %q", Version())
	}
	if NiimbluelibVersion() == "" {
		t.Error("empty niimbluelib version")
	}
}

func TestStaticCalls(t *testing.T) {
	p := newPrinter(t)

	models, err := p.Models()
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, m := range models {
		if m.Model == "B1" {
			found = m.PrintheadPixels == 384 && m.DPI == 203
		}
	}
	if !found {
		t.Errorf("B1 not in %d models (or wrong metadata)", len(models))
	}

	var tasks []string
	if err := p.Call("listPrintTasks", nil, &tasks); err != nil || len(tasks) < 5 {
		t.Errorf("listPrintTasks = %v, %v", tasks, err)
	}

	if p.IsConnected() {
		t.Error("connected before connect")
	}
}

func TestErrors(t *testing.T) {
	p := newPrinter(t)

	_, err := p.CallRaw("noSuchMethod", nil)
	var e *Error
	if !errors.As(err, &e) || !errors.Is(err, ErrOperation) || !strings.Contains(e.Message, "Unknown method") {
		t.Errorf("unknown method: %v", err)
	}

	if _, err := p.PrinterInfo(); !errors.Is(err, ErrOperation) || !strings.Contains(err.Error(), "Not connected") {
		t.Errorf("PrinterInfo before connect: %v", err)
	}

	if _, err := p.ConnectSerial("/dev/does-not-exist-niim", nil); !errors.Is(err, ErrTransport) {
		t.Errorf("bad serial port: %v", err)
	}

	if _, err := p.PrintRaw(nil, 1, 1, nil); !errors.Is(err, ErrOperation) || !strings.Contains(err.Error(), "pixel buffer missing") {
		t.Errorf("empty print: %v", err)
	}

	if _, err := p.ConnectVirtual("garbage\n<< 00", nil); err == nil {
		t.Error("bad dump accepted")
	}
}

func TestListSerialPorts(t *testing.T) {
	ports, err := ListSerialPorts()
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("ports: %v", ports)
}

func TestVirtualConnectAndPrint(t *testing.T) {
	p := newPrinter(t)
	ev := recordEvents(t, p)

	info, err := p.ConnectVirtual(b1Dump, noHeartbeat)
	if err != nil {
		t.Fatal(err)
	}
	if info.PrinterInfo.Serial != "G327071185" || info.PrinterInfo.ModelID != 4096 {
		t.Errorf("printer info: %+v", info.PrinterInfo)
	}
	if info.ModelMetadata == nil || info.ModelMetadata.Model != "B1" || info.PrintTask != "B1" {
		t.Errorf("model: %+v task %q", info.ModelMetadata, info.PrintTask)
	}
	if ev.count("connect") != 1 {
		t.Errorf("connect events = %d", ev.count("connect"))
	}
	if !p.IsConnected() {
		t.Error("not connected")
	}

	hb, err := p.Heartbeat()
	if err != nil || hb.BatteryPercents == nil || *hb.BatteryPercents != 100 {
		t.Errorf("heartbeat: %+v %v", hb, err)
	}

	res, err := p.Print(testImage(), fastPoll)
	if err != nil {
		t.Fatal(err)
	}
	if res.PrintTask != "B1" || res.Cols != 120 || res.Rows != 64 || res.Pages != 1 {
		t.Errorf("print result %+v", res)
	}
	if ev.count("printend") != 1 || ev.count("printprogress") == 0 || ev.count("printpacketprogress") == 0 {
		t.Errorf("events: %v", ev.counts)
	}

	var prog PrintProgress
	ev.mu.Lock()
	_ = json.Unmarshal(ev.last["printprogress"], &prog)
	ev.mu.Unlock()
	if prog.Page != 1 || prog.PagesTotal != 1 {
		t.Errorf("last progress %+v", prog)
	}

	if err := p.Disconnect(); err != nil {
		t.Fatal(err)
	}
	if p.IsConnected() || ev.count("disconnect") != 1 {
		t.Errorf("after disconnect: connected=%v events=%v", p.IsConnected(), ev.counts)
	}
}

func TestPrintValidation(t *testing.T) {
	p := newPrinter(t)
	if _, err := p.ConnectVirtual(b1Dump, noHeartbeat); err != nil {
		t.Fatal(err)
	}

	_, err := p.PrintRaw(make([]byte, 4), 10, 10, &PrintOptions{Format: "gray"})
	if !errors.Is(err, ErrOperation) || !strings.Contains(err.Error(), "too small") {
		t.Errorf("short buffer: %v", err)
	}

	_, err = p.Print(testImage(), &PrintOptions{PrintTask: "NOPE"})
	if err == nil || !strings.Contains(err.Error(), "unknown print task") {
		t.Errorf("bad task: %v", err)
	}

	// B1 does not support grayscale pages
	_, err = p.Print(testImage(), &PrintOptions{PageColor: PageGrayscale, StatusPollIntervalMs: 20})
	if err == nil || !strings.Contains(err.Error(), "not supported") {
		t.Errorf("grayscale on B1: %v", err)
	}
}

func TestReentrantCallFromEvent(t *testing.T) {
	p := newPrinter(t)
	got := make(chan error, 1)
	p.OnEvent(func(name string, _ json.RawMessage) {
		if name == "connect" {
			_, err := p.CallRaw("isConnected", nil)
			got <- err
		}
	})
	if _, err := p.ConnectVirtual(b1Dump, noHeartbeat); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-got:
		if !errors.Is(err, ErrReentrant) {
			t.Errorf("reentrant call: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("no connect event")
	}
}

func TestCustomTransport(t *testing.T) {
	p := newPrinter(t)
	ev := recordEvents(t, p)
	fp := newFakePrinter(t, b1Dump)

	info, err := p.ConnectCustom(func(data []byte) error {
		if resp := fp.respond(data); resp != nil {
			// Feed from another goroutine, like a BLE notification would.
			go p.Feed(resp)
		}
		return nil
	}, noHeartbeat)
	if err != nil {
		t.Fatal(err)
	}
	if info.PrintTask != "B1" || fp.requestCount() < 5 {
		t.Errorf("connect: task %q, %d requests", info.PrintTask, fp.requestCount())
	}

	// Any image type: NRGBA with transparency is composited on white.
	img := image.NewNRGBA(image.Rect(0, 0, 50, 30))
	img.Set(10, 10, color.NRGBA{A: 255})
	if _, err := p.Print(img, fastPoll); err != nil {
		t.Fatal(err)
	}

	p.TransportClosed()
	deadline := time.Now().Add(3 * time.Second)
	for p.IsConnected() && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if p.IsConnected() || ev.count("disconnect") != 1 {
		t.Errorf("after device close: connected=%v events=%v", p.IsConnected(), ev.counts)
	}
}

func TestCustomTransportWriteError(t *testing.T) {
	p := newPrinter(t)
	_, err := p.ConnectCustom(func([]byte) error { return errors.New("radio off") }, noHeartbeat)
	if !errors.Is(err, ErrOperation) {
		t.Errorf("connect with failing writer: %v", err)
	}
	if p.IsConnected() {
		t.Error("connected despite failing writer")
	}
}

func TestReconnectSwitchesTransport(t *testing.T) {
	p := newPrinter(t)
	ev := recordEvents(t, p)
	fp := newFakePrinter(t, b1Dump)

	if _, err := p.ConnectVirtual(b1Dump, noHeartbeat); err != nil {
		t.Fatal(err)
	}
	if _, err := p.ConnectCustom(func(d []byte) error {
		if r := fp.respond(d); r != nil {
			p.Feed(r) // feeding synchronously from the writer is fine too
		}
		return nil
	}, noHeartbeat); err != nil {
		t.Fatal(err)
	}
	if ev.count("connect") != 2 || ev.count("disconnect") != 1 {
		t.Errorf("events %v", ev.counts)
	}
	if _, err := p.Print(testImage(), fastPoll); err != nil {
		t.Fatal(err)
	}
}

func TestHeartbeatRuns(t *testing.T) {
	p := newPrinter(t)
	var beats atomic.Int32
	p.OnEvent(func(name string, _ json.RawMessage) {
		if name == "heartbeat" {
			beats.Add(1)
		}
	})
	if _, err := p.ConnectVirtual(b1Dump, &ConnectOptions{HeartbeatIntervalMs: 50}); err != nil {
		t.Fatal(err)
	}
	time.Sleep(400 * time.Millisecond)
	if n := beats.Load(); n < 3 {
		t.Errorf("heartbeats in 400ms at 50ms interval: %d", n)
	}
}

// Swapping the handler while events fire (also from inside a handler) must
// neither crash nor lose the newest handler; run with -race.
func TestEventHandlerSwap(t *testing.T) {
	p := newPrinter(t)
	var a, b atomic.Int32
	var handlerB EventHandler = func(string, json.RawMessage) { b.Add(1) }
	var handlerA EventHandler
	handlerA = func(name string, _ json.RawMessage) {
		a.Add(1)
		if name == "heartbeat" {
			p.OnEvent(handlerB) // from inside the handler
		}
	}
	p.OnEvent(handlerA)
	if _, err := p.ConnectVirtual(b1Dump, &ConnectOptions{HeartbeatIntervalMs: 10}); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(300 * time.Millisecond)
	for i := 0; time.Now().Before(deadline); i++ {
		switch i % 3 {
		case 0:
			p.OnEvent(handlerA)
		case 1:
			p.OnEvent(nil)
		default:
			p.OnEvent(handlerB)
		}
		time.Sleep(time.Millisecond)
	}
	p.OnEvent(handlerB)
	before := b.Load()
	time.Sleep(100 * time.Millisecond)
	if b.Load() == before {
		t.Errorf("last installed handler got no events (a=%d b=%d)", a.Load(), b.Load())
	}
}

func TestConcurrentCalls(t *testing.T) {
	p := newPrinter(t)
	if _, err := p.ConnectVirtual(b1Dump, noHeartbeat); err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	errs := make(chan error, 40)
	for i := 0; i < 40; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			if i%2 == 0 {
				_, err := p.PrinterInfo()
				errs <- err
			} else {
				_, err := p.Heartbeat()
				errs <- err
			}
		}(i)
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Error(err)
		}
	}
}

func TestManyHandles(t *testing.T) {
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			p, err := New()
			if err != nil {
				t.Error(err)
				return
			}
			if _, err := p.ConnectVirtual(b1Dump, noHeartbeat); err != nil {
				t.Error(err)
			}
			p.Close()
			p.Close() // idempotent
		}()
	}
	wg.Wait()
}

func BenchmarkNew(b *testing.B) {
	for i := 0; i < b.N; i++ {
		p, err := New()
		if err != nil {
			b.Fatal(err)
		}
		p.Close()
	}
}
