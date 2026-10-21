// Service worker : met l'app en cache pour qu'elle fonctionne hors ligne.
// Changer VERSION à chaque mise à jour des fichiers.
const VERSION = 'mes-apports-v12';
const FILES = [
  './', 'index.html', 'styles.css', 'manifest.webmanifest',
  'posture.html', 'tennis.html', 'nav.css', 'nav.js',
  'js/app.js', 'js/db.js', 'js/foods.js', 'js/model.js', 'js/nutrients.js', 'js/sync.js',
  'data/ciqual.json', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png',
];

self.addEventListener('install', e => {
  // cache: 'reload' : toujours les fichiers frais, jamais un mélange de versions venu du cache HTTP.
  e.waitUntil(caches.open(VERSION)
    .then(c => c.addAll(FILES.map(f => new Request(f, { cache: 'reload' }))))
    .then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  // Les appels à GitHub (synchronisation) passent toujours par le réseau, sans cache.
  if (e.request.method !== 'GET' || new URL(e.request.url).origin !== location.origin) return;
  e.respondWith(
    caches.match(e.request, { ignoreSearch: true }).then(hit => hit || fetch(e.request).then(res => {
      if (res.ok && new URL(e.request.url).origin === location.origin) {
        const copy = res.clone();
        caches.open(VERSION).then(c => c.put(e.request, copy));
      }
      return res;
    }).catch(() => caches.match('index.html')))
  );
});
