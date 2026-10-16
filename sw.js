// Service worker: rende disponibile offline la "shell" dell'app.
// Le previsioni NON passano da qui (le richieste a api/ vanno sempre in rete, anche login e
// logout): l'app ne tiene una copia nel localStorage per l'uso offline.
// Ad ogni modifica dei file dell'app incrementare VERSION.

const VERSION = 'v212';
const CACHE = `meteo-shell-${VERSION}`;

const SHELL = [
  './',
  './index.html',
  './info.html',
  './settings.html',
  './verify.html',
  './login.html',
  './manifest.webmanifest',
  './css/style.css',
  './js/app.js',
  './js/api.js',
  './js/storage.js',
  './js/chart.js',
  './js/weather.js',
  './js/station.js',
  './js/radar.js',
  './js/rivers.js',
  './js/settings.js',
  './js/theme.js',
  './js/auth-guard.js',
  './js/verify.js',
  './js/login.js',
  './icons/icon-v3.svg',
  './icons/icon-192-v3.png',
  './icons/icon-512-v3.png',
  './icons/icon-maskable-512-v3.png',
  './icons/apple-touch-icon-v3.png',
];

// Shell scaricata sempre dalla rete (cache: 'reload'): le immagini hanno 7 giorni di cache HTTP
// (nginx) e altrimenti la nuova versione potrebbe rimettere in cache quelle vecchie.
self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE)
    .then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' }))))
    .then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('meteo-shell-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// La pagina chiede la versione per mostrarla nel piè di pagina (showVersion() in app.js).
self.addEventListener('message', (event) => {
  if (event.data === 'version') event.source?.postMessage({ version: VERSION });
});

// Stale-while-revalidate per i file della stessa origine; le API esterne vanno in rete.
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  // API del nostro server (previsioni, centralina, medie): sempre dalla rete, mai dalla
  // cache del service worker (dati che cambiano; l'app ha già la sua copia offline).
  if (url.pathname.includes('/api/')) return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const cached = await cache.match(req, { ignoreSearch: true })
      || (req.mode === 'navigate' ? await cache.match('./index.html') : undefined);
    const network = fetch(req)
      .then((res) => {
        if (res.ok) cache.put(req, res.clone());
        return res;
      })
      .catch(() => undefined);
    if (cached) {
      event.waitUntil(network);
      return cached;
    }
    return (await network) || new Response('Offline', { status: 503, statusText: 'Offline' });
  })());
});
