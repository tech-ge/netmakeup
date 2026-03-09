/* ============================================================
   TechGeo Network — Service Worker
   Strategy:
     • Static assets  → Cache First (instant loads)
     • API GET calls  → Network First, fall back to cached response
     • API POST/PUT   → Network only; if offline, queue and retry when back online
     • HTML pages     → Cache First (stale-while-revalidate)
   ============================================================ */

const CACHE_VERSION = 'techgeo-v2';
const STATIC_CACHE  = CACHE_VERSION + '-static';
const API_CACHE     = CACHE_VERSION + '-api';

/* Files to pre-cache on install */
const PRECACHE_URLS = [
  '/',
  '/index.html',
  '/dashboard.html',
  '/style.css',
  /* Google Fonts — cached at runtime on first visit */
];

/* API routes that are safe to cache (GET only) */
const CACHEABLE_API = [
  // NOTE: wallet/balance endpoints intentionally excluded — must always be fresh
  // '/api/users/profile',   <- excluded: contains live wallet balance
  // '/api/users/dashboard', <- excluded: contains live wallet balance
  '/api/referrals/stats',
  '/api/referrals/link',
  '/api/blogs',
  '/api/surveys',
  '/api/writing-jobs',
  '/api/transcription',
  '/api/data-entry',
  '/api/notifications',
];

/* ── INSTALL: pre-cache static shell ── */
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(STATIC_CACHE)
      .then(cache => cache.addAll(PRECACHE_URLS))
      .then(() => self.skipWaiting())
  );
});

/* ── ACTIVATE: delete old caches ── */
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(k => k.startsWith('techgeo-') && k !== STATIC_CACHE && k !== API_CACHE)
          .map(k => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

/* ── FETCH: routing logic ── */
self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);

  /* Skip non-GET for API — let them go to network (handled by sync queue) */
  if (request.method !== 'GET') return;

  /* ── Google Fonts / CDN assets: Cache First ── */
  if (url.hostname.includes('fonts.googleapis.com') ||
      url.hostname.includes('fonts.gstatic.com') ||
      url.hostname.includes('cdnjs.cloudflare.com')) {
    event.respondWith(cacheFirst(request, STATIC_CACHE));
    return;
  }

  /* ── API GET: Network First → cache fallback ── */
  if (url.pathname.startsWith('/api/')) {
    const cacheable = CACHEABLE_API.some(p => url.pathname.startsWith(p));
    if (cacheable) {
      event.respondWith(networkFirstAPI(request));
    }
    /* Non-cacheable API (admin etc) — let fall through to network normally */
    return;
  }

  /* ── HTML pages & static assets: Cache First, update in background ── */
  event.respondWith(staleWhileRevalidate(request));
});

/* ── STRATEGY: Cache First ── */
async function cacheFirst(request, cacheName) {
  const cached = await caches.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok) {
    const cache = await caches.open(cacheName);
    cache.put(request, response.clone());
  }
  return response;
}

/* ── STRATEGY: Stale While Revalidate ── */
async function staleWhileRevalidate(request) {
  const cache  = await caches.open(STATIC_CACHE);
  const cached = await cache.match(request);
  const fetchPromise = fetch(request).then(response => {
    if (response.ok) cache.put(request, response.clone());
    return response;
  }).catch(() => cached); /* if network fails and we have cached: use it */
  return cached || fetchPromise;
}

/* ── STRATEGY: Network First for API ── */
async function networkFirstAPI(request) {
  const cache = await caches.open(API_CACHE);
  try {
    const response = await fetch(request);
    if (response.ok) {
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    /* Offline — serve stale API data with offline header */
    const cached = await cache.match(request);
    if (cached) {
      const body    = await cached.json();
      const headers = new Headers(cached.headers);
      headers.set('X-TechGeo-Offline', 'true');
      return new Response(JSON.stringify(body), {
        status:  200,
        headers: headers,
      });
    }
    /* Nothing cached at all — return friendly offline response */
    return new Response(
      JSON.stringify({ error: 'You are offline. Please check your internet connection.', offline: true }),
      { status: 503, headers: { 'Content-Type': 'application/json' } }
    );
  }
}

/* ── BACKGROUND SYNC: retry queued POST requests ── */
self.addEventListener('sync', event => {
  if (event.tag === 'techgeo-sync-queue') {
    event.waitUntil(replayQueue());
  }
});

async function replayQueue() {
  try {
    const db    = await openQueueDB();
    const items = await getAllQueued(db);
    for (const item of items) {
      try {
        const res = await fetch(item.url, {
          method:  item.method,
          headers: item.headers,
          body:    item.body,
        });
        if (res.ok) {
          await deleteQueued(db, item.id);
          /* Notify all open tabs that a queued action succeeded */
          self.clients.matchAll().then(clients => {
            clients.forEach(c => c.postMessage({ type: 'SYNC_SUCCESS', url: item.url }));
          });
        }
      } catch { /* still offline — leave in queue */ }
    }
  } catch(e) {
    console.warn('[SW] Queue replay error:', e);
  }
}

/* ── IndexedDB queue helpers ── */
function openQueueDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('techgeo-queue', 1);
    req.onupgradeneeded = e => e.target.result.createObjectStore('requests', { keyPath: 'id', autoIncrement: true });
    req.onsuccess = e => resolve(e.target.result);
    req.onerror   = e => reject(e.target.error);
  });
}
function getAllQueued(db) {
  return new Promise((resolve, reject) => {
    const tx  = db.transaction('requests', 'readonly');
    const req = tx.objectStore('requests').getAll();
    req.onsuccess = e => resolve(e.target.result);
    req.onerror   = e => reject(e.target.error);
  });
}
function deleteQueued(db, id) {
  return new Promise((resolve, reject) => {
    const tx  = db.transaction('requests', 'readwrite');
    const req = tx.objectStore('requests').delete(id);
    req.onsuccess = () => resolve();
    req.onerror   = e => reject(e.target.error);
  });
}
