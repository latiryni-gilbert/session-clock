// The service worker. Built by vite-plugin-pwa (strategy "injectManifest"), which fills in the list of files to
// precache. It does what the generated worker used to do (offline caching, and waiting for the user's OK before
// an update takes over) and adds background alerts (Web Push).
import { cleanupOutdatedCaches, createHandlerBoundToURL, precacheAndRoute, type PrecacheEntry } from 'workbox-precaching'
import { NavigationRoute, registerRoute } from 'workbox-routing'
import { handleNotificationClick, handlePush } from './sw/pushHandlers'

declare const self: ServiceWorkerGlobalScope & { __WB_MANIFEST: Array<string | PrecacheEntry> }

// A new version waits until the page asks for it (the "Update available" prompt's Reload button sends this).
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') void self.skipWaiting()
})

precacheAndRoute(self.__WB_MANIFEST)
cleanupOutdatedCaches()
// Every page navigation is answered with the cached app shell, so the app opens offline.
registerRoute(new NavigationRoute(createHandlerBoundToURL('index.html')))

self.addEventListener('push', (event) => handlePush(event, self.registration))
self.addEventListener('notificationclick', (event) => handleNotificationClick(event, self.clients, self.registration))
