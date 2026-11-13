# Friendly Color Selection

Take a picture, tap a color, get its hex code and matching palettes.

- Live camera capture (or choose an existing photo)
- Tap or drag on the picture to pick a color, with a magnifier
- Hex, RGB and HSL values — tap any color to copy its hex code
- Complementary, split-complementary, analogous, triadic and tetradic palettes, plus tints and shades
- Installable to a phone's home screen and works offline after the first visit

## Running

It is a static site with no build step. The camera needs a secure page, so serve it over
HTTPS (GitHub Pages works) or from `localhost`:

```
python3 -m http.server 8000
```

Then open http://localhost:8000.
