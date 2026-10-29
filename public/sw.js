// Service Worker: App installierbar + offline lesbar + Push.
// Grundsatz: Online immer frisch vom Server (HTML/API network-first), versionierte Assets cache-first.
const SHELL = 'quotes-shell-v1';
const ASSETS = 'quotes-assets-v1';
const API = 'quotes-api-v1';
// Nur lesende Endpunkte, die man offline sinnvoll anzeigen kann
const API_CACHEABLE = /^\/api\/(me|config|quotes(\/\d+)?|collections(\/\d+)?|groups|tags|daily|notifications|stats|users\/[^/]+)$/;

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil((async () => {
  const keep = new Set([SHELL, ASSETS, API]);
  for (const key of await caches.keys()) if (!keep.has(key)) await caches.delete(key);
  await self.clients.claim();
})()));

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // Versionierte Assets: unveränderlich -> Cache zuerst; ältere Versionen beim Wechsel aufräumen
  if (url.pathname.startsWith('/assets/')) {
    event.respondWith((async () => {
      const cache = await caches.open(ASSETS);
      const hit = await cache.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok) {
        cache.put(req, res.clone());
        const version = url.pathname.split('/')[2];
        for (const old of await cache.keys()) if (new URL(old.url).pathname.split('/')[2] !== version) cache.delete(old);
      }
      return res;
    })());
    return;
  }

  // Seitenaufrufe: Netz zuerst, offline die zuletzt geladene App-Hülle
  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const res = await fetch(req);
        if (res.ok && !/^\/[scg]\//.test(url.pathname)) (await caches.open(SHELL)).put('/', res.clone());
        return res;
      } catch {
        return (await caches.match('/', { cacheName: SHELL })) ?? new Response('Offline', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
      }
    })());
    return;
  }

  // Ausgewählte API-Antworten: Netz zuerst, offline der letzte Stand
  if (API_CACHEABLE.test(url.pathname)) {
    event.respondWith((async () => {
      const cache = await caches.open(API);
      try {
        const res = await fetch(req);
        if (res.ok) cache.put(req, res.clone());
        else if (res.status === 401) await caches.delete(API); // abgemeldet -> nichts Privates aufheben
        return res;
      } catch {
        const hit = await cache.match(req);
        if (hit) return hit;
        return new Response(JSON.stringify({ error: 'Offline – dieser Inhalt wurde noch nicht geladen.' }), { status: 503, headers: { 'Content-Type': 'application/json' } });
      }
    })());
  }
});

// Abmelden: zwischengespeicherte API-Daten (privat) löschen
self.addEventListener('message', (e) => {
  if (e.data === 'logout') e.waitUntil(caches.delete(API));
});

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data?.json() ?? {}; } catch { data = { title: 'Quotes', body: event.data?.text() ?? '' }; }
  event.waitUntil(self.registration.showNotification(data.title || 'Quotes', {
    body: data.body || '', icon: '/icons/icon-192.png', badge: '/icons/badge-64.png', tag: data.tag, data: { url: data.url || '/' },
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || '/', self.location.origin).href;
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const win = wins.find((w) => new URL(w.url).origin === self.location.origin);
    if (win) { await win.focus(); return win.navigate(target); }
    return self.clients.openWindow(target);
  })());
});
