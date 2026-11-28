/* Service Worker ЕГЭ-100: офлайн-режим + обновление по кнопке «Синхронизировать» */
const CACHE_PREFIX = 'ege100-cache-';
const DEFAULT_CACHE = CACHE_PREFIX + 'current';

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((k) => k.startsWith(CACHE_PREFIX) && k !== DEFAULT_CACHE)
          .map((k) => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

async function precacheFromVersion() {
  const scope = self.registration.scope;
  const vUrl = new URL('version.json?t=' + Date.now(), scope).toString();
  const resp = await fetch(vUrl, { cache: 'no-store' });
  if (!resp.ok) throw new Error('Не удалось загрузить version.json (' + resp.status + ')');
  const meta = await resp.json();
  const files = Array.isArray(meta.files) ? meta.files : [];
  const cacheName = CACHE_PREFIX + (meta.version || Date.now());
  const cache = await caches.open(cacheName);

  // Всегда кэшируем корень и все файлы из version.json с обходом HTTP-кэша
  const targets = ['./', ...files];
  let cachedCount = 0;
  for (const rel of targets) {
    const absUrl = new URL(rel, scope).toString();
    const bustUrl = absUrl + (absUrl.includes('?') ? '&' : '?') + '_sw=' + encodeURIComponent(meta.version || Date.now());
    try {
      const r = await fetch(bustUrl, { cache: 'no-store' });
      if (r.ok) {
        await cache.put(absUrl, r.clone());
        cachedCount++;
      }
    } catch (e) {
      // пропускаем единичный сбой, чтобы не сорвать остальное обновление
    }
  }

  // Удаляем старые кэши
  const allKeys = await caches.keys();
  await Promise.all(
    allKeys
      .filter((k) => k.startsWith(CACHE_PREFIX) && k !== cacheName)
      .map((k) => caches.delete(k))
  );

  return { ok: true, version: meta.version || null, built_at: meta.built_at || null, cached: cachedCount, total: targets.length };
}

self.addEventListener('message', (event) => {
  const msg = event.data || {};
  if (msg.type === 'SYNC_CONTENT') {
    precacheFromVersion()
      .then((res) => {
        if (event.ports && event.ports[0]) event.ports[0].postMessage(res);
      })
      .catch((err) => {
        if (event.ports && event.ports[0]) {
          event.ports[0].postMessage({ ok: false, error: String(err && err.message || err) });
        }
      });
  }
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  // Не перехватываем внешние API (GitHub Gist) и локальный /api/
  if (url.origin !== self.location.origin) return;
  if (url.pathname.includes('/api/') || url.pathname.endsWith('/version.json')) return;

  // Network-first для HTML/JS, с откатом в кэш для офлайна
  event.respondWith(
    (async () => {
      const cleanUrl = url.origin + url.pathname;
      try {
        const netResp = await fetch(req, { cache: 'no-cache' });
        if (netResp && netResp.ok) {
          const keys = await caches.keys();
          const active = keys.find((k) => k.startsWith(CACHE_PREFIX)) || DEFAULT_CACHE;
          const cache = await caches.open(active);
          cache.put(cleanUrl, netResp.clone()).catch(() => {});
        }
        return netResp;
      } catch (e) {
        const cached = await caches.match(req, { ignoreSearch: true }) || await caches.match(cleanUrl);
        if (cached) return cached;
        throw e;
      }
    })()
  );
});
