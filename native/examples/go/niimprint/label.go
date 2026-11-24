package main

import (
	"image"
	"image/color"
	"image/draw"

	"golang.org/x/image/font"
	"golang.org/x/image/font/gofont/gobold"
	"golang.org/x/image/font/opentype"
	"golang.org/x/image/math/fixed"
)

// RenderText draws centered black text on a white w x h label, shrinking the
// font until it fits inside the margins.
func RenderText(text string, w, h int) (*image.Gray, error) {
	img := image.NewGray(image.Rect(0, 0, w, h))
	draw.Draw(img, img.Bounds(), &image.Uniform{C: color.White}, image.Point{}, draw.Src)

	f, err := opentype.Parse(gobold.TTF)
	if err != nil {
		return nil, err
	}

	margin := w / 10
	var face font.Face
	var adv fixed.Int26_6
	for size := float64(h) * 0.45; size > 6; size -= 2 {
		face, err = opentype.NewFace(f, &opentype.FaceOptions{Size: size, DPI: 72, Hinting: font.HintingFull})
		if err != nil {
			return nil, err
		}
		adv = font.MeasureString(face, text)
		if adv.Ceil() <= w-2*margin {
			break
		}
	}

	m := face.Metrics()
	textH := (m.Ascent + m.Descent).Ceil()
	d := &font.Drawer{
		Dst:  img,
		Src:  image.NewUniform(color.Black),
		Face: face,
		Dot: fixed.Point26_6{
			X: fixed.I((w - adv.Ceil()) / 2),
			Y: fixed.I((h-textH)/2) + m.Ascent,
		},
	}
	d.DrawString(text)

	// thin frame, handy to see the printable area on the label
	for x := 2; x < w-2; x++ {
		img.SetGray(x, 2, color.Gray{})
		img.SetGray(x, h-3, color.Gray{})
	}
	for y := 2; y < h-2; y++ {
		img.SetGray(2, y, color.Gray{})
		img.SetGray(w-3, y, color.Gray{})
	}
	return img, nil
}
