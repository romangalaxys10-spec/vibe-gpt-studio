import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    // Proxy API + session-aware preview route to the Express backend (port 3099).
    // Two cases handled:
    //   - /preview           -> direct passthrough to backend /preview
    //   - /preview.html      -> rewrite to backend /preview (Vite serves index.html
    //                           for unknown .html paths otherwise, masking the route)
    //   - /api/*             -> backend API
    proxy: {
      '/preview.html': {
        target: 'http://localhost:3099',
        rewrite: (p) => '/preview' + (p.includes('?') ? p.slice(p.indexOf('?')) : ''),
        changeOrigin: true
      },
      '/preview': 'http://localhost:3099',
      '/api': 'http://localhost:3099'
    }
  }
})
