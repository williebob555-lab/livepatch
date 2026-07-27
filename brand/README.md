# LivePatch brand kit

_Last verified: 2026-07-26. Source of truth: the `.svg` files in this folder.
Everything in `png/` and `build/icon.ico` is generated — never hand-edit them._

## The idea

A CV cable draws the **L** and the **P**'s stem, then plugs into an audio
socket that forms the bowl. The letterform *is* the patch.

The colours are not a palette choice — they're the app's own signal colours,
lifted from `src/core/types.ts`. Purple in the logo means CV exactly as purple
on a wire means CV in the editor.

## Files

| File | Use it for |
|------|-----------|
| `mark-square.svg` | The mark. App icon ≥64 px, anywhere square. |
| `mark-square-small.svg` | 32–48 px only. Thicker cable, wider socket hole. |
| `mark-square-tiny.svg` | 16–24 px only. Everything grows so the socket's hole survives as a pixel. |
| `mark-circle.svg` | Avatars — GitHub, Discord, anything masked to a circle. |
| `mark-mono.svg` | One colour, inherits `currentColor`. Engraving, watermarks. |
| `wordmark.svg` | Name alone, dark backgrounds. |
| `wordmark-light.svg` | Name alone, light backgrounds. |
| `wordmark-stacked.svg` | Two lines with the cable running Live → Patch. Splash, About, square crops. |
| `lockup-horizontal.svg` | **Primary lockup.** Mark + name, dark backgrounds. |
| `lockup-horizontal-light.svg` | Same, light backgrounds. |
| `module.svg` | Secondary illustration. Splash art, store listings — never the icon. |
| `banner-readme.svg` | 1280×280 README header. |
| `banner-social.svg` | 1280×640 GitHub social preview / OG image. |

Raster exports of all of these live in `png/`.

## Three icon variants, and why

One drawing cannot serve 16 px and 256 px. The socket is the whole problem: its
hole is what says "P", and scaled straight down that hole closes and the mark
becomes a purple blob with a blue dot. So each size band gets its own drawing,
and `scripts/make-brand.cjs` maps them:

| Size | Variant |
|------|---------|
| 256, 128, 64 | `mark-square.svg` |
| 48, 32 | `mark-square-small.svg` |
| 24, 16 | `mark-square-tiny.svg` |

If you change the mark, **verify by magnifying the actual `.ico` entries** —
not by looking at the SVG zoomed out. They lie in opposite directions.

## Colour

Signal colours, straight from `defaultTheme` in `src/core/types.ts`:

| Role | Hex | Where |
|------|-----|-------|
| Audio | `#5fb2ff` | The socket. "Patch" in the wordmark. |
| CV | `#c9a2ff` | The cable. The fader cap. |
| MIDI | `#7ee08a` | Module jack, stacked-lockup fader cap. |
| Tape | `#e8a13d` | Available, unused in the core marks. |
| Rolls | `#8ad6c8` | Available, unused in the core marks. |

Supporting neutrals: field `#14161a`, raised field `#1b1f26` (the mark's tile
when it sits *on* `#14161a`), hairline `#2a2f38`, fader track `#333c49`, text
`#e8ecf2`, muted `#94a3b8`, faint `#5b6572`.

Light-background substitutions: text → `#14161a`, audio → `#1f6fd0`, CV →
`#6f4fd0`. The dark-canvas signal colours do not hold contrast on white.

## Type

`Segoe UI Variable Display` → `Segoe UI` → `Inter` → system sans. Bold (700) at
`-3` tracking for the name; medium (500) for taglines.

**The wordmark is typeset, not drawn.** The letters are live text and the fader
is positioned to Segoe metrics, so on a machine without Segoe the spacing
drifts. Use the PNGs in `png/` anywhere the exact shape matters. Drawing the
nine letterforms as geometry is the outstanding job.

## Rules

- **One substitution only.** The fader works because a fader cap is
  unmistakably an object. Swapping a letter for a bare stroke — a slack-cable
  `v`, an arc `c` — just reads as a mismatched font. Both were tried and cut.
- **Don't add cables to the mark.** Branching extra cables off the spine for
  the sake of a third colour destroys the `LP`. Tried, cut.
- **Don't re-space** the mark and wordmark. Use `lockup-*.svg`.
- **Don't put the dark-field mark on a dark background** without the raised
  tile (`#1b1f26`) — the banners show the pattern.
- **Clear space** is the mark's corner radius (56 units at mark scale). It's
  already inside the lockup viewBoxes; don't crop into it.
- **Don't stretch.** Every export size in `make-brand.cjs` matches its SVG's
  aspect ratio; a mismatch silently distorts.

## Regenerating

```
npm run brand
```

Rasterizes every SVG to `png/` and rebuilds `build/icon.ico`. Runs under
Electron because Chromium is the only rasterizer this project has — no
ImageMagick, no Pillow, no sharp — which also means the PNGs carry the same
font rendering the app itself uses.

`build/icon.ico` is picked up by electron-builder (`electron-builder.yml` →
`win.icon`) and by the dev window in `electron/main.cjs`. After changing a
mark: `npm run brand`, then `npm run package` to see it on the executable.
