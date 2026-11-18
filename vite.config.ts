import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// base './' keeps asset paths relative, so the build works on
// mendozaliner.github.io/noahmenendez.com/ now and on the custom domain later.
export default defineConfig({
  base: './',
  plugins: [react()],
})
