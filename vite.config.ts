import { defineConfig } from 'vite'

// Vite refuses requests for host names it doesn't know. Allow the live domain,
// Railway's own preview address and Cloudflare quick tunnels used for sharing a dev build.
const allowedHosts = ['frogeproof.fun', 'www.frogeproof.fun', '.up.railway.app', '.trycloudflare.com']

export default defineConfig({
  server: { allowedHosts },
  // `npm start` on Railway serves the built site; Railway supplies PORT
  preview: {
    allowedHosts,
    host: true,
    port: Number(process.env.PORT) || 4173,
    strictPort: true,
  },
})
