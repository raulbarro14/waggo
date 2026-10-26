/**
 * Service worker: guarda la app para que abra sin conexión.
 * - Archivos propios: primero la red (así ves siempre la última versión) y, sin conexión, la copia guardada.
 * - Firebase SDK y fuentes (URLs con versión): primero la copia guardada.
 * - Firestore y el inicio de sesión no pasan por aquí; Firestore tiene su propia caché.
 * Sube CACHE (v2, v3…) si cambias la lista de archivos.
 */
const CACHE = 'turnos-paseo-v2';
const SHELL = [
  './',
  './index.html',
  './app.js',
  './backend.js',
  './firebase-config.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png'
];
const CDN_HOSTS = ['www.gstatic.com', 'fonts.googleapis.com', 'fonts.gstatic.com'];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (url.origin === self.location.origin) {
    event.respondWith(networkFirst(req));
  } else if (CDN_HOSTS.includes(url.hostname)) {
    event.respondWith(cacheFirst(req));
  }
});

async function networkFirst(req) {
  const cache = await caches.open(CACHE);
  try {
    // no-cache: pregunta siempre al servidor, saltándose la caché de 10 min de GitHub Pages
    const fresh = req.mode === 'navigate' ? new Request(req.url, { cache: 'no-cache' }) : new Request(req, { cache: 'no-cache' });
    const res = await fetch(fresh);
    if (res.ok) cache.put(req, res.clone());
    return res;
  } catch (e) {
    const hit = await cache.match(req, { ignoreSearch: true });
    if (hit) return hit;
    if (req.mode === 'navigate') return cache.match('./index.html');
    throw e;
  }
}

async function cacheFirst(req) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok || res.type === 'opaque') cache.put(req, res.clone());
  return res;
}
