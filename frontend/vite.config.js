import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const target = process.env.BACKEND_URL || 'http://127.0.0.1:8000'
const isStatic = process.env.VITE_STATIC === '1'
const derivWs = process.env.VITE_DERIV_WS_URL || 'wss://ws.derivws.com'

// Static (GitHub Pages) builds hold Deriv tokens in the browser, so lock the page down: scripts only
// from this origin, network connections only to Deriv.
const csp = [
  "default-src 'self'",
  "script-src 'self'",
  "worker-src 'self'",
  `connect-src 'self' ${new URL(derivWs).origin}`,
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src https://fonts.gstatic.com",
  "img-src 'self' data:",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join('; ')

export default defineConfig({
  base: process.env.VITE_BASE || '/',
  plugins: [
    react(),
    isStatic && {
      name: 'static-csp',
      transformIndexHtml: (html) => html.replace('<head>', `<head>\n    <meta http-equiv="Content-Security-Policy" content="${csp}" />\n    <meta name="referrer" content="no-referrer" />`),
    },
  ],
  server: {
    port: 5173,
    proxy: {
      '/api': target,
      '/ws': { target: target.replace('http', 'ws'), ws: true },
    },
  },
})
