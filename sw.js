// Service worker do admin · RSB Eventos.
//
// Estratégia:
//   - App shell (HTML/CSS/JS/imagens/manifest): cache-first com revalidação.
//   - data/*.json e api.github.com: NÃO cacheado (estado mutável, autoritativo).
//   - script.google.com (Apps Script bridge): NÃO cacheado.
//   - CDNs (cdn.jsdelivr.net): cache-first (versões pinned, raras mudanças).
//
// Bump CACHE_VERSION ao alterar o app shell.

const CACHE_VERSION = 'rsb-eventos-v8-pat-aplicado';

const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './js/app.js',
  './assets/rsb-brasao.png',
  './assets/lisboa-cml-transparent.png'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_VERSION)
      .then(cache => cache.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_VERSION).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const req = event.request;
  const url = new URL(req.url);

  // Estado mutável — nunca cachear
  if (url.host === 'api.github.com') return;
  if (url.host.indexOf('script.google') >= 0) return;
  if (url.host.indexOf('googleusercontent.com') >= 0) return;
  if (url.pathname.indexOf('/data/') >= 0 && url.pathname.endsWith('.json')) return;

  // CDN: cache-first (versões pinned)
  if (url.host === 'cdn.jsdelivr.net' || url.host === 'cdnjs.cloudflare.com') {
    event.respondWith(cacheFirst(req));
    return;
  }

  // Mesmo origin: cache-first com revalidação
  if (url.origin === self.location.origin) {
    event.respondWith(cacheFirstRevalidate(req));
  }
});

function cacheFirst(req) {
  return caches.match(req).then(cached => {
    if (cached) return cached;
    return fetch(req).then(res => {
      if (res && res.ok) {
        const copy = res.clone();
        caches.open(CACHE_VERSION).then(c => c.put(req, copy)).catch(()=>{});
      }
      return res;
    });
  });
}

function cacheFirstRevalidate(req) {
  return caches.match(req).then(cached => {
    const fetched = fetch(req).then(res => {
      if (res && res.ok) {
        const copy = res.clone();
        caches.open(CACHE_VERSION).then(c => c.put(req, copy)).catch(()=>{});
      }
      return res;
    }).catch(() => cached);
    return cached || fetched;
  });
}
