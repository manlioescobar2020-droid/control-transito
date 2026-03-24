// sw.js
const CACHE_NAME = 'transito-st-v1';
const ASSETS_TO_CACHE = [
  '/',
  '/index.html',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js'
];

// INSTALACIÓN: cachea assets básicos
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => {
        console.log('Cache abierto, guardando archivos...');
        return cache.addAll(ASSETS_TO_CACHE);
      })
      .catch(err => console.log('Error al cachear:', err))
  );
  self.skipWaiting();
});

// FETCH: estrategia cache-first, red como fallback
self.addEventListener('fetch', (event) => {
  event.respondWith(
    caches.match(event.request).then((cachedResponse) => {
      if (cachedResponse) {
        return cachedResponse;
      }
      return fetch(event.request).catch(() => {
        console.log('Sin conexión y recurso no cacheado:', event.request.url);
      });
    })
  );
});

// ACTIVATE: limpia caches viejos
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) =>
      Promise.all(
        cacheNames.map((cacheName) => {
          if (cacheName !== CACHE_NAME) {
            console.log('Borrando caché viejo:', cacheName);
            return caches.delete(cacheName);
          }
        })
      )
    )
  );
});
