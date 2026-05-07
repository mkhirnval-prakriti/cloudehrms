/**
 * Minimal offline-friendly shell: never cache /api; hashed /assets/ use stale-while-revalidate.
 */
const CACHE = 'hrms-app-v3'

self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting())
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys()
      await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
      await self.clients.claim()
    })()
  )
})

self.addEventListener('fetch', (event) => {
  const { request } = event
  if (request.method !== 'GET') return
  let url
  try {
    url = new URL(request.url)
  } catch {
    return
  }
  if (url.origin !== self.location.origin) return
  if (url.pathname.startsWith('/api')) return

  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(staleWhileRevalidate(request))
    return
  }

  event.respondWith(networkFirst(request))
})

async function staleWhileRevalidate(request) {
  const cache = await caches.open(CACHE)
  const cached = await cache.match(request)
  const network = fetch(request)
    .then((response) => {
      if (response.ok) cache.put(request, response.clone())
      return response
    })
    .catch(() => null)
  if (cached) {
    void network
    return cached
  }
  const response = await network
  if (response) return response
  return Response.error()
}

// ── Web Push notifications ──────────────────────────────────────────────
self.addEventListener('push', (event) => {
  let data = {}
  try { data = event.data ? event.data.json() : {} } catch { data = { title: 'Notice', body: event.data?.text() || '' } }
  const title = data.title || '📢 New Notice'
  const options = {
    body: data.body || '',
    icon: '/logo.png',
    badge: '/logo.png',
    tag: data.tag || 'hrms-notice',
    renotify: true,
    data: { url: data.url || '/notices', noticeId: data.noticeId },
    requireInteraction: false,
  }
  event.waitUntil(self.registration.showNotification(title, options))
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const target = event.notification.data?.url || '/notices'
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    for (const c of all) {
      if (c.url.includes(target) && 'focus' in c) return c.focus()
    }
    for (const c of all) {
      if ('navigate' in c && 'focus' in c) { try { await c.navigate(target) } catch {} ; return c.focus() }
    }
    if (self.clients.openWindow) return self.clients.openWindow(target)
  })())
})

async function networkFirst(request) {
  const cache = await caches.open(CACHE)
  try {
    const response = await fetch(request)
    if (response.ok) cache.put(request, response.clone())
    return response
  } catch {
    const cached = await cache.match(request)
    if (cached) return cached
    const root = await cache.match('/')
    if (root) return root
    return Response.error()
  }
}
