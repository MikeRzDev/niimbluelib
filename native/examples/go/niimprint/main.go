// niimprint prints text or an image on a NIIMBOT printer over Bluetooth LE or serial.
//
//	go run . -ble B1 -text "Hello World"
//	go run . -port /dev/ttyACM0 -image label.png
//	go run . -text "Hello World" -out preview.png   (render only)
//	go run . -scan                                  (list BLE devices)
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"image"
	_ "image/jpeg"
	"image/png"
	"log"
	"os"
	"time"

	niimblue "github.com/MultiMote/niimbluelib/native/go"
)

func main() {
	var (
		bleName  = flag.String("ble", "", "connect over Bluetooth LE to the printer whose name starts with this (e.g. B1)")
		port     = flag.String("port", "", "connect over a serial port instead (e.g. /dev/ttyACM0)")
		text     = flag.String("text", "", "text to print")
		imgPath  = flag.String("image", "", "PNG/JPEG image to print")
		width    = flag.Int("w", 384, "label width in pixels for -text (B1: 8 px/mm, max 384)")
		height   = flag.Int("h", 240, "label height in pixels for -text")
		density  = flag.Int("density", 0, "print density (0 = model default)")
		quantity = flag.Int("n", 1, "copies")
		out      = flag.String("out", "", "only render the label to this PNG, do not print")
		verbose  = flag.Bool("v", false, "print library events")
		scan     = flag.Bool("scan", false, "list Bluetooth LE devices for 10s and exit")
	)
	flag.Parse()

	if *scan {
		if err := Scan(10 * time.Second); err != nil {
			log.Fatal(err)
		}
		return
	}

	img, err := loadLabel(*text, *imgPath, *width, *height)
	if err != nil {
		log.Fatal(err)
	}
	if *out != "" {
		if err := savePNG(*out, img); err != nil {
			log.Fatal(err)
		}
		fmt.Println("wrote", *out)
		return
	}
	if (*bleName == "") == (*port == "") {
		log.Fatal("use exactly one of -ble or -port (or -out to only render)")
	}

	p, err := niimblue.New()
	if err != nil {
		log.Fatal(err)
	}
	defer p.Close()
	p.OnEvent(func(name string, payload json.RawMessage) {
		switch {
		case name == "printprogress":
			var pr niimblue.PrintProgress
			_ = json.Unmarshal(payload, &pr)
			fmt.Printf("  page %d/%d  print %d%%  feed %d%%\n", pr.Page, pr.PagesTotal, pr.PagePrintProgress, pr.PageFeedProgress)
		case *verbose, name == "log":
			fmt.Printf("  [%s] %s\n", name, payload)
		}
	})

	opts := &niimblue.ConnectOptions{Heartbeat: niimblue.Bool(false)}
	var info *niimblue.ConnectionInfo
	if *bleName != "" {
		ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
		defer cancel()
		fmt.Printf("scanning for %q...\n", *bleName)
		ble, err := FindBLE(ctx, *bleName)
		if err != nil {
			log.Fatal(err)
		}
		defer ble.Close()
		fmt.Printf("found %s\n", ble.Name)
		info, err = ble.Connect(p, opts)
		if err != nil {
			log.Fatal(err)
		}
	} else {
		info, err = p.ConnectSerial(*port, opts)
		if err != nil {
			log.Fatal(err)
		}
	}

	pi := info.PrinterInfo
	model := "unknown"
	if info.ModelMetadata != nil {
		model = info.ModelMetadata.Model
	}
	fmt.Printf("connected: %s (model %s, fw %s, serial %s, battery %d%%, task %s)\n",
		info.DeviceName, model, pi.SoftwareVersion, pi.Serial, pi.BatteryPercents, info.PrintTask)

	b := img.Bounds()
	fmt.Printf("printing %dx%d px, %d copies...\n", b.Dx(), b.Dy(), *quantity)
	res, err := p.Print(img, &niimblue.PrintOptions{Quantity: *quantity, Density: *density})
	if err != nil {
		log.Fatal(err)
	}
	fmt.Printf("done: %+v\n", *res)
	_ = p.Disconnect()
}

func loadLabel(text, path string, w, h int) (image.Image, error) {
	switch {
	case text != "" && path != "":
		return nil, fmt.Errorf("use -text or -image, not both")
	case text != "":
		return RenderText(text, w, h)
	case path != "":
		f, err := os.Open(path)
		if err != nil {
			return nil, err
		}
		defer f.Close()
		img, _, err := image.Decode(f)
		return img, err
	}
	return nil, fmt.Errorf("nothing to print: pass -text or -image")
}

func savePNG(path string, img image.Image) error {
	f, err := os.Create(path)
	if err != nil {
		return err
	}
	defer f.Close()
	return png.Encode(f, img)
}
