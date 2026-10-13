import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
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
