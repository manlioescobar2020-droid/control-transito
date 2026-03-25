const CACHE_NAME = 'transito-st-v2'; // Cambié a v2 para forzar actualización si ya tenían una vieja
const ASSETS_TO_CACHE = [
    '/',
    '/index.html',
    '/socket.io/socket.io.js', // Intentamos cachear el socket, aunque a veces se regenera
    // Hojas de estilo y scripts externos (CDN)
    'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
    'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
    'https://cdn.jsdelivr.net/npm/toastify-js/src/toastify.min.css',
    'https://cdn.jsdelivr.net/npm/toastify-js',
    'https://cdn.jsdelivr.net/npm/chart.js'
];

// Instalación: guardamos los archivos en caché
self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then((cache) => {
                console.log('Cacheando archivos principales...');
                return cache.addAll(ASSETS_TO_CACHE);
            })
            .catch(err => console.log('Error al cachear en install:', err))
    );
    self.skipWaiting();
});

// Fetch: Servimos desde caché si no hay internet
self.addEventListener('fetch', (event) => {
    // Estrategia: Cache First, falling back to Network
    event.respondWith(
        caches.match(event.request)
            .then((response) => {
                if (response) {
                    return response; // Si está en caché, lo devolvemos
                }
                // Si no está en caché, vamos a la red
                return fetch(event.request).then((networkResponse) => {
                    // Opcional: Podríamos guardar en caché dinámico las nuevas peticiones aquí
                    return networkResponse;
                });
            })
            .catch(() => {
                // Si falla todo (offline y no está en caché), podríamos devolver una página offline básica
                console.log('Modo offline y recurso no cacheado:', event.request.url);
            })
    );
});

// Activación: Limpiamos cachés viejos
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
