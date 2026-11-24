package main

import (
	"fmt"
	"sort"
	"sync"
	"time"

	"tinygo.org/x/bluetooth"
)

// Scan lists BLE devices advertising during d (diagnostics: is the printer visible?).
func Scan(d time.Duration) error {
	adapter := bluetooth.DefaultAdapter
	if err := adapter.Enable(); err != nil {
		return err
	}
	var mu sync.Mutex
	seen := map[string]string{}
	time.AfterFunc(d, func() { _ = adapter.StopScan() })
	err := adapter.Scan(func(_ *bluetooth.Adapter, r bluetooth.ScanResult) {
		mu.Lock()
		defer mu.Unlock()
		key := r.Address.String()
		if _, ok := seen[key]; !ok || seen[key] == "" {
			tag := ""
			if r.HasServiceUUID(niimbotService) {
				tag = "  <- NIIMBOT service"
			}
			seen[key] = fmt.Sprintf("%-40q rssi %4d%s", r.LocalName(), r.RSSI, tag)
		}
	})
	keys := make([]string, 0, len(seen))
	for k := range seen {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		fmt.Printf("%s  %s\n", k, seen[k])
	}
	fmt.Printf("%d devices\n", len(seen))
	return err
}
