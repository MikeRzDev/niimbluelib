package main

import (
	"context"
	"fmt"
	"sort"
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

// bleDevice is a printer seen during a scan.
type bleDevice struct {
	Name    string
	Address bluetooth.Address
	RSSI    int16
}

var enableOnce = sync.OnceValue(func() error { return bluetooth.DefaultAdapter.Enable() })

// scanPrinters lists devices advertising the NIIMBOT service (or a known
// NIIMBOT name prefix) during d.
func scanPrinters(ctx context.Context, d time.Duration) ([]bleDevice, error) {
	if err := enableOnce(); err != nil {
		return nil, fmt.Errorf("enable bluetooth: %w", err)
	}
	adapter := bluetooth.DefaultAdapter

	var mu sync.Mutex
	seen := map[string]bleDevice{}
	ctx, cancel := context.WithTimeout(ctx, d)
	defer cancel()
	go func() {
		<-ctx.Done()
		_ = adapter.StopScan()
	}()

	err := adapter.Scan(func(_ *bluetooth.Adapter, r bluetooth.ScanResult) {
		name := r.LocalName()
		if !r.HasServiceUUID(niimbotService) && !looksLikeNiimbot(name) {
			return
		}
		mu.Lock()
		defer mu.Unlock()
		prev, ok := seen[r.Address.String()]
		if !ok || prev.Name == "" {
			seen[r.Address.String()] = bleDevice{Name: name, Address: r.Address, RSSI: r.RSSI}
		}
	})
	if err != nil && ctx.Err() == nil {
		return nil, fmt.Errorf("scan: %w", err)
	}

	mu.Lock()
	defer mu.Unlock()
	out := make([]bleDevice, 0, len(seen))
	for _, d := range seen {
		out = append(out, d)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].RSSI > out[j].RSSI })
	return out, nil
}

func looksLikeNiimbot(name string) bool {
	n := strings.ToUpper(name)
	for _, p := range []string{"B1", "B18", "B21", "B203", "B3S", "D11", "D110", "D101", "D110M", "K3"} {
		if strings.HasPrefix(n, p+"-") || strings.HasPrefix(n, p+"_") {
			return true
		}
	}
	return false
}

// bleLink is an open Bluetooth LE connection used as a niimblue custom transport.
type bleLink struct {
	name   string
	device bluetooth.Device
	char   bluetooth.DeviceCharacteristic
	mtu    int
	mu     sync.Mutex
}

func dialBLE(d bleDevice) (*bleLink, error) {
	if err := enableOnce(); err != nil {
		return nil, fmt.Errorf("enable bluetooth: %w", err)
	}
	dev, err := bluetooth.DefaultAdapter.Connect(d.Address, bluetooth.ConnectionParams{})
	if err != nil {
		return nil, fmt.Errorf("connect %s: %w", d.Name, err)
	}
	services, err := dev.DiscoverServices([]bluetooth.UUID{niimbotService})
	if err != nil || len(services) == 0 {
		_ = dev.Disconnect()
		return nil, fmt.Errorf("NIIMBOT service not found on %s: %v", d.Name, err)
	}
	chars, err := services[0].DiscoverCharacteristics(nil)
	if err != nil || len(chars) == 0 {
		_ = dev.Disconnect()
		return nil, fmt.Errorf("no characteristics on %s: %v", d.Name, err)
	}
	l := &bleLink{name: d.Name, device: dev, char: chars[0], mtu: 20}
	if mtu, err := l.char.GetMTU(); err == nil && mtu > 3 {
		l.mtu = int(mtu) - 3
	}
	return l, nil
}

// connect wires the link to the printer handle and runs the handshake.
func (l *bleLink) connect(p *niimblue.Printer, opts *niimblue.ConnectOptions) (*niimblue.ConnectionInfo, error) {
	if err := l.char.EnableNotifications(func(buf []byte) {
		p.Feed(append([]byte(nil), buf...))
	}); err != nil {
		return nil, fmt.Errorf("enable notifications: %w", err)
	}
	return p.ConnectCustom(l.write, opts)
}

// write sends one packet, split to the MTU if needed (runs on the library thread).
func (l *bleLink) write(data []byte) error {
	l.mu.Lock()
	defer l.mu.Unlock()
	for len(data) > 0 {
		n := min(len(data), l.mtu)
		if _, err := l.char.WriteWithoutResponse(data[:n]); err != nil {
			return err
		}
		data = data[n:]
	}
	return nil
}

func (l *bleLink) close() {
	time.Sleep(100 * time.Millisecond) // let the last packets go out
	_ = l.device.Disconnect()
}
