/* ╔══════════════════════════════════════════════════════════════════════════
 * ║  RAKHSHII — SERVICE WORKER v9.2
 * ║
 * ║  Two jobs:
 * ║   1. Offline retry queue — engine.js posts failed CAPI events here
 * ║      via postMessage. We persist them in IndexedDB and replay on
 * ║      'online' / 'sync' events. No silent drops.
 * ║   2. Minimal asset cache — for instant return-visit reload (engine.js,
 * ║      sw.js, hero image). HTML stays network-first so content updates
 * ║      reach users immediately.
 * ║
 * ║  Note: GET routes (/weights, /stats) are NOT cached — they need to be
 * ║  fresh. Only static assets are cached.
 * ╚══════════════════════════════════════════════════════════════════════════ */

const VERSION = 'rkh-v9.2';
const STATIC_CACHE = 'rkh-static-' + VERSION;
const STATIC_ASSETS = [
  './engine.js',
  './assets/hero_sunset.jpg',
  './assets/about_moon.jpg',
  './assets/trust_beach.jpg',
];

// ─── INSTALL ────────────────────────────────────────────────────────────────
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(STATIC_CACHE).then((c) => c.addAll(STATIC_ASSETS)).catch(() => {})
  );
  self.skipWaiting();
});

// ─── ACTIVATE — cleanup old caches ──────────────────────────────────────────
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== STATIC_CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// ─── FETCH — cache-first for static, network-first for HTML ────────────────
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Don't intercept the Worker (CAPI) — needs to hit network always
  if (/\.workers\.dev/.test(url.hostname)) return;

  // Static assets — cache-first
  if (/\.(js|jpe?g|png|webp|svg|css|woff2?)$/i.test(url.pathname)) {
    event.respondWith(
      caches.match(req).then((hit) => hit || fetch(req).then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(STATIC_CACHE).then((c) => c.put(req, copy)).catch(() => {});
        }
        return res;
      }).catch(() => hit))
    );
    return;
  }

  // HTML / everything else — network-first, fallback to cache
  event.respondWith(
    fetch(req).then((res) => {
      if (res && res.ok && req.url.endsWith('/')) {
        const copy = res.clone();
        caches.open(STATIC_CACHE).then((c) => c.put(req, copy)).catch(() => {});
      }
      return res;
    }).catch(() => caches.match(req))
  );
});

// ─── OFFLINE RETRY QUEUE — IndexedDB ────────────────────────────────────────
const DB_NAME = 'rkh-queue';
const STORE   = 'events';

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}

async function dbAdd(record) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).add(record);
    tx.oncomplete = () => resolve();
    tx.onerror    = () => reject(tx.error);
  });
}

async function dbAll() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror   = () => reject(req.error);
  });
}

async function dbDelete(id) {
  const db = await openDB();
  return new Promise((resolve) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror    = () => resolve();
  });
}

async function flushQueue() {
  const all = await dbAll().catch(() => []);
  for (const rec of all) {
    try {
      const res = await fetch(rec.url, {
        method  : 'POST',
        body    : rec.body,
        headers : { 'Content-Type': 'text/plain;charset=UTF-8' },
        keepalive : true,
      });
      if (res && res.ok) await dbDelete(rec.id);
    } catch (_) {
      // network still flaky — leave it queued, try again later
      break;
    }
  }
}

// ─── MESSAGE — engine.js posts events here when network failed ─────────────
self.addEventListener('message', async (event) => {
  const data = event.data || {};
  if (data.type === 'queue_event' && data.url && data.body) {
    try {
      await dbAdd({ url: data.url, body: data.body, ts: Date.now() });
      // Try flush immediately — maybe network is back already
      flushQueue();
    } catch (_) {}
  }
});

// ─── ONLINE / SYNC — replay queued events ──────────────────────────────────
self.addEventListener('online', () => flushQueue());
self.addEventListener('sync', (event) => {
  if (event.tag === 'flush-events') event.waitUntil(flushQueue());
});

// Periodic best-effort flush (covers cases where 'online' didn't fire)
setInterval(() => flushQueue(), 60000);
