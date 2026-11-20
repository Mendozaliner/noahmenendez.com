# noahmenendez.com

Interactive isometric office for Noah Menendez's personal site.

- Vite + React + React Three Fiber
- Photoreal Cycles renders from Blender (`office_iso_vNN.blend`) are the base image
- Drag to swing the room ±35° (pre-rendered frames, springs back to the hero view)
- Lights switch crossfades day / lights-off renders
- A transparent three.js layer uses a camera matched to the Blender `iso_camera`, so live overlays (the real-time clock hands, later the click targets) sit exactly on the render

## Develop

    npm install
    npm run dev

## Deploy

Pushing to `main` builds and deploys to GitHub Pages via `.github/workflows/deploy.yml`.
Renders live in `public/img/{day,night}/swing_±NN.webp`; scene constants in `src/scene.generated.ts`.

## Live 3D test page (`lab.html`)

The next version of the room: baked Cycles lighting drawn in real time with React Three Fiber, so it stays sharp at any size.
It is a separate entry (`lab.html`, `src/lab/`) with its own assets in `public-lab/rt/`. The deploy builds it into `/lab/` next to the main site: https://mendozaliner.github.io/noahmenendez.com/lab/

- `npm run build:lab` builds it into `dist-lab/` (`lab.html` there is the page; serve the folder to view it).
- `src/lab/Lab.tsx`: camera with snap-back, day/night crossfade (wall light switch), clickable props, wall clock on the visitor's local time.
- `src/lab/hotspots.ts`: which prop opens which link (ids are baked into `public-lab/rt/room.json`).
- `public-lab/rt/room.json`: packed room geometry; `rt_*.webp` / `rt_*_n.webp`: day / night lighting atlases.
