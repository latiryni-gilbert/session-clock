import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { registerSW } from 'virtual:pwa-register'
import './index.css'
import App from './App.tsx'
import { markUpdateAvailable } from './lib/swUpdate'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

// Offline support. When a new version has been downloaded, show the "Update available" prompt instead of
// switching silently; the user's Reload click activates it. (In `npm run dev` this does nothing.)
const CHECK_EVERY_MS = 60 * 60 * 1000
const updateServiceWorker = registerSW({
  onNeedRefresh() {
    markUpdateAvailable(() => void updateServiceWorker(true))
  },
  onRegisteredSW(_url, registration) {
    // The app is often left open all day, so look for a new version now and then, not only on page load.
    if (registration) setInterval(() => void registration.update(), CHECK_EVERY_MS)
  },
})
