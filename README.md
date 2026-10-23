# Particle Shore

A browser tool for building synthetic shapes out of light and particles — grainy,
stippled images like sand dunes under a grazing sun or a shaft of light through a
doorway — and exporting them as 4K/8K PNG or vector SVG.

## Run

```bash
node serve.mjs
```

Then open http://localhost:5178. No install or build step is needed; it is plain
ES modules and WebGL2 (any current Chrome, Safari or Firefox).

## How it works

1. **Shape** — a GLSL function evaluates a light field for the frame. Six shapes:
   Dunes (raymarched heightfield with soft shadows), Light beam, Orb, Silk,
   Eclipse and Smoke.
2. **Particles** — millions of candidate points are scattered on the GPU; each
   survives with a probability equal to the toned light at its position, then is
   drawn as a dot with random size and brightness, accumulated additively.
3. **Tone** — accumulated light is mapped with `1 − e^−x` onto your background
   and ink colours.

All sizes and densities are defined in 4K pixels, and candidates live on a fixed
grid, so the 100% view, every export tile and every output size render exactly
the same particles.

## Controls

| | |
|---|---|
| Drag on the image | Move the composition |
| Pinch / ⌘-scroll | Zoom the composition around the cursor |
| Double-click | Inspect actual export pixels at 100% (drag to pan); again to fit |
| `R` / `S` | Randomize the shape / new seed |
| `F` / `1` | Fit / 100% view |
| `E` | Export PNG |
| `⌘Z` / `⇧⌘Z` | Undo / redo |
| `⌘S` | Save settings as JSON |
| Double-click a slider label | Reset that value |

Settings persist in the browser between sessions.

## Export

- **PNG** — 4K UHD by default (also DCI 4K, 5K, 8K, HD). Rendered in 2048 px
  tiles and encoded in the browser, optionally with a transparent background.
- **SVG** — samples a particle budget (10k–1M) from the same shader and enlarges
  the dots so the overall brightness matches the raster. Choose circles (best
  compatibility) or compact paths (smaller files), varied or solid opacity.

Every PNG and SVG embeds its settings. Drop one back on the window (or use
*Load…*) to restore the exact image.

## Files

- `src/scenes.js` — the shapes: GLSL plus their parameter definitions
- `src/shaders.js` — field, particle, composite and present passes
- `src/renderer.js` — WebGL2 pipeline, tiling and transform-feedback capture for SVG
- `src/params.js` — global parameters, defaults and presets
- `src/main.js`, `src/ui.js` — app state, panel and interaction
- `src/png.js`, `src/svg.js` — exporters

To add a shape, add an entry to `SCENES` in `src/scenes.js`: a `params` list
(each becomes a `uniform float u_<key>`) and a `glsl` string that defines
`vec2 scene(vec2 q)` returning `(light, grainScale)`.
