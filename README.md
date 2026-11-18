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
