/**
 * BIOCore Service Worker — SP-FX-44
 *
 * Cache 策略:
 *   静态资源 (/_next/static/**, /icons/**, *.js, *.css 等)  → Cache-First, 1 日 TTL
 *   GET /api/v1/scada/views* | /api/v1/scada/projects*      → Network-First, 5s 超时
 *   POST/PUT/DELETE /api/** | /api/v1/auth/** | /admin/**    → Network-Only (不 cache)
 *   navigate (HTML document)                                 → Network-First, 失败 → /offline
 *
 * 安全:
 *   - auth endpoint 不 cache
 *   - write-intent POST 不 cache (POST 全部 network-only)
 *   - admin/* 不 cache
 */

const SW_VERSION = 'v75';
const CACHE_STATIC = `biocore-static-${SW_VERSION}`;
const CACHE_API = `biocore-api-${SW_VERSION}`;
const CACHE_OFFLINE = `biocore-offline-${SW_VERSION}`;

const OFFLINE_URL = '/offline';

// 静态资源 URL 模式
const STATIC_PATTERNS = [
  /^\/_next\/static\//,
  /^\/icons\//,
];

// 静态资源扩展名
const STATIC_EXTENSIONS = /\.(js|css|woff2|woff|ttf|otf|png|jpg|jpeg|svg|ico|webp)$/i;

// API GET 缓存路径 (network-first)
const API_CACHEABLE_PATTERNS = [
  /^\/api\/v1\/scada\/views/,
  /^\/api\/v1\/scada\/projects/,
];

// 绝对不 cache 的路径 (auth / admin / write-intent 等)
const NEVER_CACHE_PATTERNS = [
  /^\/api\/v1\/auth\//,
  /^\/admin\//,
];

const API_TIMEOUT_MS = 5000;

// ─── install ───────────────────────────────────────────────────────────────
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_OFFLINE).then((cache) =>
      cache.add(OFFLINE_URL)
    ).then(() => {
      // 立即激活, 不等旧 worker 卸载
      return self.skipWaiting();
    })
  );
});

// ─── activate ──────────────────────────────────────────────────────────────
self.addEventListener('activate', (event) => {
  const validCaches = new Set([CACHE_STATIC, CACHE_API, CACHE_OFFLINE]);
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => !validCaches.has(key))
          .map((key) => caches.delete(key))
      )
    ).then(() => self.clients.claim())
  );
});

// ─── message ───────────────────────────────────────────────────────────────
// 接收来自页面的 SKIP_WAITING 指令 (用于热更新)
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

// ─── fetch ─────────────────────────────────────────────────────────────────
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // 只处理同源请求
  if (url.origin !== self.location.origin) return;

  // POST / PUT / DELETE — Network-Only (不 cache, 安全)
  if (request.method !== 'GET') return;

  // 绝对不 cache 的路径
  if (NEVER_CACHE_PATTERNS.some((p) => p.test(url.pathname))) return;

  // navigate request — HTML 页面
  if (request.mode === 'navigate') {
    event.respondWith(networkFirstNavigate(request));
    return;
  }

  // API GET — network-first (带 5s 超时)
  if (API_CACHEABLE_PATTERNS.some((p) => p.test(url.pathname))) {
    event.respondWith(networkFirstApi(request));
    return;
  }

  // 静态资源 — cache-first
  const isStaticPath = STATIC_PATTERNS.some((p) => p.test(url.pathname));
  const isStaticExt = STATIC_EXTENSIONS.test(url.pathname);
  if (isStaticPath || isStaticExt) {
    event.respondWith(cacheFirstStatic(request));
    return;
  }
});

// ─── 策略函数 ───────────────────────────────────────────────────────────────

/**
 * Cache-First — 静态资源
 * 命中 cache → 直接返回; 未命中 → fetch + 存 cache
 */
async function cacheFirstStatic(request) {
  const cached = await caches.match(request);
  if (cached) return cached;

  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(CACHE_STATIC);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    // 静态资源无 offline fallback — 让浏览器自行处理
    return new Response('Resource unavailable offline', { status: 503 });
  }
}

/**
 * Network-First — API GET (5s 超时)
 * 网络成功 → 存 cache 并返回; 超时或失败 → fallback 到 cache
 */
async function networkFirstApi(request) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), API_TIMEOUT_MS);

  try {
    const response = await fetch(request, { signal: controller.signal });
    clearTimeout(timeoutId);
    if (response.ok) {
      const cache = await caches.open(CACHE_API);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    clearTimeout(timeoutId);
    const cached = await caches.match(request);
    if (cached) return cached;
    return new Response(JSON.stringify({ success: false, error: 'offline', data: null }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

/**
 * Network-First — navigate (HTML document)
 * 网络成功 → 返回; 失败 → /offline 页面
 */
async function networkFirstNavigate(request) {
  try {
    return await fetch(request);
  } catch {
    const offlinePage = await caches.match(OFFLINE_URL, { cacheName: CACHE_OFFLINE });
    if (offlinePage) return offlinePage;
    return new Response('<h1>离线</h1><p>请检查网络连接</p>', {
      status: 503,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  }
}
