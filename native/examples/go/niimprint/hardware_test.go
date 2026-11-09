package main

import (
	"context"
	"encoding/json"
	"os"
	"testing"
	"time"

	niimblue "github.com/MultiMote/niimbluelib/native/go"
)

// Hardware test: prints "Hello World" on a real printer. Skipped unless
//
//	NIIM_HW_BLE=B1          (Bluetooth LE name prefix), or
//	NIIM_HW_PORT=/dev/...   (serial port)
//
// is set. Optional NIIM_HW_TEXT overrides the text.
func TestHardwareHelloWorld(t *testing.T) {
	bleName, port := os.Getenv("NIIM_HW_BLE"), os.Getenv("NIIM_HW_PORT")
	if bleName == "" && port == "" {
		t.Skip("set NIIM_HW_BLE or NIIM_HW_PORT to print on a real printer")
	}
	text := os.Getenv("NIIM_HW_TEXT")
	if text == "" {
		text = "Hello World"
	}

	p, err := niimblue.New()
	if err != nil {
		t.Fatal(err)
	}
	defer p.Close()

	events := map[string]int{}
	evCh := make(chan string, 256)
	p.OnEvent(func(name string, payload json.RawMessage) {
		if name == "log" {
			t.Logf("log: %s", payload)
		}
		select {
		case evCh <- name:
		default:
		}
	})

	opts := &niimblue.ConnectOptions{Heartbeat: niimblue.Bool(false)}
	var info *niimblue.ConnectionInfo
	if bleName != "" {
		ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
		defer cancel()
		ble, err := FindBLE(ctx, bleName)
		if err != nil {
			t.Fatal(err)
		}
		defer ble.Close()
		t.Logf("BLE device %s (mtu payload %d)", ble.Name, ble.mtu)
		info, err = ble.Connect(p, opts)
		if err != nil {
			t.Fatal(err)
		}
	} else {
		info, err = p.ConnectSerial(port, opts)
		if err != nil {
			t.Fatal(err)
		}
	}
	t.Logf("connected: %s", info.Raw)
	if info.PrintTask == "" {
		t.Fatalf("no print task detected for model %+v", info.ModelMetadata)
	}

	hb, err := p.Heartbeat()
	if err != nil {
		t.Fatal(err)
	}
	hbJSON, _ := json.Marshal(hb)
	t.Logf("heartbeat: %s", hbJSON)

	w, h := 384, 240
	if m := info.ModelMetadata; m != nil && m.PrintDirection == "top" && m.PrintheadPixels < w {
		w = m.PrintheadPixels
	}
	img, err := RenderText(text, w, h)
	if err != nil {
		t.Fatal(err)
	}
	res, err := p.Print(img, &niimblue.PrintOptions{Quantity: 1})
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("printed: %+v", *res)

	close(evCh)
	for n := range evCh {
		events[n]++
	}
	if events["printend"] != 1 {
		t.Errorf("printend events = %d (all: %v)", events["printend"], events)
	}
	if err := p.Disconnect(); err != nil {
		t.Error(err)
	}
}

func TestRenderText(t *testing.T) {
	img, err := RenderText("Hello World", 384, 240)
	if err != nil {
		t.Fatal(err)
	}
	black := 0
	for _, v := range img.Pix {
		if v < 128 {
			black++
		}
	}
	if black < 1000 {
		t.Errorf("only %d black pixels rendered", black)
	}
}
