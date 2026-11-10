/* Service worker: l'app funziona anche senza connessione.
   Quando pubblicate una nuova versione dei file, cambiate VERSION. */
const VERSION = 'v1.2.1';
const CACHE = `spese-nozze-${VERSION}`;
const PAGE = './';
const ASSETS = [
  PAGE,
  './styles.css',
  './app.js',
  './manifest.webmanifest',
  './fonts/bodoni-moda.woff2',
  './fonts/hanken-grotesk.woff2',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png',
  './icons/favicon-32.png',
  './icons/favicon-64.png',
  './img/illustrazione.webp',
  './img/anelli.webp',
  './img/monete.webp'
];

// Alcuni hosting (Cloudflare) reindirizzano /index.html a /: una risposta
// "reindirizzata" non può servire una navigazione, quindi se ne salva una copia pulita.
async function cleanResponse(res) {
  if (!res.redirected) return res;
  const body = await res.blob();
  return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
}

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await Promise.all(ASSETS.map(async (url) => {
      const res = await fetch(url, { cache: 'reload' });
      if (!res.ok) throw new Error(`${url}: ${res.status}`);
      await cache.put(url, await cleanResponse(res));
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('spese-nozze-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Prima la copia salvata (istantanea, funziona offline), poi aggiorna in background.
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return; // la sincronizzazione non passa dalla cache

  const isPage = req.mode === 'navigate' && (url.pathname === '/' || url.pathname === '/index.html');
  if (req.mode === 'navigate' && !isPage) {
    // altre pagine (es. /scopri/): dalla rete, con la copia salvata se manca la connessione
    event.respondWith(fetch(req).then(async (res) => {
      if (res.ok) { const c = await caches.open(CACHE); await c.put(req, await cleanResponse(res.clone())); }
      return res;
    }).catch(async () => (await caches.match(req)) || Response.redirect('/', 302)));
    return;
  }
  const key = isPage ? PAGE : req;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const cached = await cache.match(key, { ignoreSearch: isPage });
    const network = fetch(isPage ? PAGE : req).then(async (res) => {
      if (res && res.ok && res.type === 'basic') await cache.put(key, await cleanResponse(res.clone()));
      return res;
    }).catch(() => null);
    if (cached) { event.waitUntil(network); return cached; }
    const res = await network;
    if (res) return isPage ? cleanResponse(res) : res;
    return new Response('Offline', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  })());
});
