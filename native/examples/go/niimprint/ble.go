package main

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"

	niimblue "github.com/MultiMote/niimbluelib/native/go"
	"tinygo.org/x/bluetooth"
)

// NIIMBOT BLE service (same filter niimbluelib uses for Web Bluetooth).
var niimbotService = bluetooth.NewUUID([16]byte{
	0xe7, 0x81, 0x0a, 0x71, 0x73, 0xae, 0x49, 0x9d, 0x8c, 0x15, 0xfa, 0xa9, 0xae, 0xf0, 0xc3, 0xf2,
})

// BLE is a Bluetooth LE transport for niimblue.Printer.ConnectCustom.
type BLE struct {
	Name   string
	device bluetooth.Device
	char   bluetooth.DeviceCharacteristic
	mtu    int
	mu     sync.Mutex
}

// FindBLE scans for a printer whose advertised name starts with namePrefix
// (e.g. "B1", or the full name "B1-H808250313").
func FindBLE(ctx context.Context, namePrefix string) (*BLE, error) {
	adapter := bluetooth.DefaultAdapter
	if err := adapter.Enable(); err != nil {
		return nil, fmt.Errorf("enable bluetooth: %w", err)
	}

	found := make(chan bluetooth.ScanResult, 1)
	scanErr := make(chan error, 1)
	go func() {
		scanErr <- adapter.Scan(func(a *bluetooth.Adapter, r bluetooth.ScanResult) {
			name := r.LocalName()
			if name == "" || !strings.HasPrefix(strings.ToLower(name), strings.ToLower(namePrefix)) {
				return
			}
			select {
			case found <- r:
				_ = a.StopScan()
			default:
			}
		})
	}()

	var res bluetooth.ScanResult
	select {
	case res = <-found:
	case err := <-scanErr:
		return nil, fmt.Errorf("scan: %w", err)
	case <-ctx.Done():
		_ = adapter.StopScan()
		return nil, fmt.Errorf("no printer named %q* found: %w", namePrefix, ctx.Err())
	}

	dev, err := adapter.Connect(res.Address, bluetooth.ConnectionParams{})
	if err != nil {
		return nil, fmt.Errorf("connect %s: %w", res.LocalName(), err)
	}

	services, err := dev.DiscoverServices([]bluetooth.UUID{niimbotService})
	if err != nil || len(services) == 0 {
		_ = dev.Disconnect()
		return nil, fmt.Errorf("NIIMBOT service not found on %s: %v", res.LocalName(), err)
	}
	chars, err := services[0].DiscoverCharacteristics(nil)
	if err != nil || len(chars) == 0 {
		_ = dev.Disconnect()
		return nil, fmt.Errorf("no characteristics on %s: %v", res.LocalName(), err)
	}

	b := &BLE{Name: res.LocalName(), device: dev, char: chars[0], mtu: 20}
	if mtu, err := b.char.GetMTU(); err == nil && mtu > 3 {
		b.mtu = int(mtu) - 3
	}
	return b, nil
}

// Connect wires the BLE link to the printer handle and runs the handshake.
func (b *BLE) Connect(p *niimblue.Printer, opts *niimblue.ConnectOptions) (*niimblue.ConnectionInfo, error) {
	if err := b.char.EnableNotifications(func(buf []byte) {
		p.Feed(append([]byte(nil), buf...))
	}); err != nil {
		return nil, fmt.Errorf("enable notifications: %w", err)
	}
	return p.ConnectCustom(b.write, opts)
}

// write sends one packet, split to the MTU if needed (runs on the library thread).
func (b *BLE) write(data []byte) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	for len(data) > 0 {
		n := min(len(data), b.mtu)
		if _, err := b.char.WriteWithoutResponse(data[:n]); err != nil {
			return err
		}
		data = data[n:]
	}
	return nil
}

func (b *BLE) Close() error {
	if b == nil {
		return errors.New("not connected")
	}
	time.Sleep(100 * time.Millisecond) // let the last packets go out
	return b.device.Disconnect()
}
