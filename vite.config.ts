import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'
import { VitePWA } from 'vite-plugin-pwa'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      // "prompt": a new version waits until the user chooses to reload (see UpdatePrompt), it never swaps in silently.
      registerType: 'prompt',
      injectRegister: false, // src/main.tsx registers the worker itself
      includeAssets: ['favicon.svg', 'favicon.ico', 'apple-touch-icon.png'],
      manifest: {
        id: '/',
        name: 'Session Clock',
        short_name: 'Sessions',
        description: 'Which trading sessions are open right now, in your local time.',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        orientation: 'any',
        background_color: '#0a0a0a',
        theme_color: '#0a0a0a',
        categories: ['finance', 'productivity'],
        lang: 'en',
        icons: [
          { src: 'pwa-192x192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: 'pwa-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: 'pwa-maskable-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      // A hand-written worker (src/sw.ts) instead of a generated one: it adds the push handlers for background alerts.
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.ts',
      injectManifest: {
        // Everything the app needs is a static file, so cache it all (icons included) for offline use.
        globPatterns: ['**/*.{js,css,html,svg,png,ico,webmanifest}'],
        // A classic script, which every browser that can install the app supports.
        rollupFormat: 'iife',
      },
    }),
  ],
  test: {
    // Two projects so the existing logic tests keep running in plain Node while component
    // tests (*.test.tsx) get a browser-like DOM.
    projects: [
      {
        extends: true,
        test: {
          name: 'logic',
          environment: 'node',
          include: ['src/**/*.test.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'components',
          environment: 'jsdom',
          include: ['src/**/*.test.tsx'],
          setupFiles: ['./src/test/setup.ts'],
          // The app reads the browser's time zone; pin it so component tests see the same one everywhere.
          env: { TZ: 'America/New_York' },
        },
      },
    ],
  },
})
