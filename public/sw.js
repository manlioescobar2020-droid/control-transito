const CACHE_NAME = 'transito-st-v1';
// Lista de archivos indispensables para que la app funcione offline
const ASSETS_TO_CACHE = [
    '/',
    '/index.html',
    // Si tienes archivos CSS o JS separados, agrégalos aquí.
    // Si usas CDNs (Leaflet, Toastify), es mejor cachearlos dinámicamente o incluir las URLs aquí.
    'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
    'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
    // Agrega aquí tus íconos o logos si tienes
];

// Evento de instalación: guarda los archivos en caché
self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then((cache) => {
                console.log('Cache abierto, guardando archivos...');
                return cache.addAll(ASSETS_TO_CACHE);
            })
            .catch(err => console.log('Error al cachear:', err))
    );
    self.skipWaiting(); // Activa el SW inmediatamente
});

// Evento de fetch: sirve desde caché si no hay internet
self.addEventListener('fetch', (event) => {
    event.respondWith(
        caches.match(event.request)
            .then((response) => {
                // Si está en caché, devuelve la versión caché
                if (response) {
                    return response;
                }
                // Si no, intenta buscar en la red
                return fetch(event.request).then((networkResponse) => {
                    // Opcional: Guardar nuevas respuestas en caché dinámico
                    return networkResponse;
                });
            })
            .catch(() => {
                // Si falla la red y no está en caché, podríamos devolver una página offline genérica
                console.log('Sin conexión y recurso no cacheado');
            })
    );
});

// Limpiar cachés viejos al activar
self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((cacheNames) => {
            return Promise.all(
                cacheNames.map((cacheName) => {
                    if (cacheName !== CACHE_NAME) {
                        console.log('Borrando caché viejo:', cacheName);
                        return caches.delete(cacheName);
                    }
                })
            );
        })
    );
});
