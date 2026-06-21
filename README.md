# three.js City Generator — React Three Fiber

A React Three Fiber port of the experimental **city generator** example from the
three.js [`city` branch](https://github.com/mrdoob/three.js/compare/dev...city).
It renders a few procedurally generated blocks of Neo-Gothic terracotta
skyscrapers at sunset, with a physical sky driving both the backdrop and the
image-based lighting.

> **Requires WebGPU.** Use a recent Chrome/Edge, or Safari Technology Preview.
> The generator uses WebGPU node materials (TSL); there is no WebGL fallback.

## Run

```bash
npm install
npm run dev      # http://localhost:5173
npm run build    # production build
npm run preview  # serve the production build
```

Use the buttons (top-right) to switch between the two views, and the **leva**
panel for each view's controls.

## Views

### City

The full ported example: the `seed` and `time of day` sliders drive the layout
and the sun.

### Interior Window Lab

A standalone, heavily-commented demo of the **interior-mapping** technique that
makes the skyscraper windows look into furnished rooms — using a *single flat
plane* and no geometry or textures. Every room (walls, floor, ceiling, table,
sofa, wardrobes, curtains, lit lamps, fake corner AO) is raymarched per-pixel in
a TSL shader. Live sliders let you experiment:

- `interior mapping` — toggle to compare the effect against flat dark glass
- `window width/height`, `frame width`, `glazing bar` — the window grid
- `room depth` — how deep the illusory rooms recede
- `lit rooms` — fraction of rooms with the lights on (they emit/glow)
- `corner AO`, `furniture`, `curtains`, and a `reseed` button

The technique lives in [`src/interior/interiorMapping.js`](src/interior/interiorMapping.js).
It's the same trick as `interior()` in `SkyscraperGenerator.js`, rewritten
without the per-vertex baked room attributes so it's easy to read in isolation.

> **How it works in one line:** for each pixel, intersect the view ray with an
> imaginary box behind the glass, find where it *exits*, and colour that point —
> giving real parallax for the cost of a few divides, no loop.

## How it works

The generator sources are vendored from the three.js `city` branch under
`src/generators/` (unmodified except for one import path):

- `generators/CityGenerator.js` — lays out the grid of blocks/lots and the road
  material.
- `generators/city/SkyscraperGenerator.js` — builds a single tower and its
  shared TSL material.
- `generators/city/SidewalkGenerator.js` — instanced curbs/sidewalks.

The original example is a vanilla three.js HTML file driving the WebGPU renderer
imperatively. This port keeps that imperative scene setup (sky, PMREM
environment baking, key light, ground, city) but hosts it inside R3F:

- `src/App.jsx` — sets up the `<Canvas>` with an async `gl` factory that creates
  and initializes a `WebGPURenderer`, plus drei `OrbitControls`.
- `src/Scene.jsx` — uses `useThree()` to grab the renderer/scene and builds the
  city, sky and lighting in effects; leva controls drive `seed` / `time of day`.

### Notes on the three.js WebGPU + R3F integration

- WebGPU-specific imports (`WebGPURenderer`, node materials, TSL) come from
  `three/webgpu` and `three/tsl`. The bare `three` specifier is left as the
  standard build so R3F and drei still get `WebGLRenderer` (the WebGPU build
  doesn't export it). three's scene graph is duck-typed, so objects created from
  `three` render fine under the `WebGPURenderer`. See `vite.config.js`.
- The original mapped `"three"` to the WebGPU build via an importmap; this is the
  bundler-equivalent that avoids breaking R3F/drei.

The reference copy of the original example files is kept under `_ref/` for
comparison (excluded from Vite's dependency scan).
