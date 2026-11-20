import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { resolve } from 'node:path'
// Standalone build of the live-3D test page (lab.html only), with its own asset folder.
export default defineConfig({
  base: './',
  publicDir: 'public-lab',
  plugins: [react()],
  build: { outDir: 'dist-lab', emptyOutDir: true, rollupOptions: { input: { lab: resolve(__dirname, 'lab.html') } } },
})
