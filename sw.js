/* CS-30 / CS-10 立ち座りテスト計測 — Service Worker
   役割:
   1) アプリ本体をキャッシュしてオフラインでも起動できるようにする
   2) MediaPipe の配信ファイル（CDN）を初回取得時にキャッシュし、2回目以降は通信なしで動くようにする
   3) PWA としてインストール可能にする（fetch ハンドラが必須のため）
*/

const VERSION = 'cs30-v1.0.0';
const SHELL_CACHE = 'shell-' + VERSION;
const CDN_CACHE   = 'cdn-' + VERSION;

/* アプリ本体（相対パス。サブディレクトリ配信でも動く） */
const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png'
];

/* このホストのファイルは取得したら保存しておく（MediaPipeのwasm・モデル本体） */
const CDN_HOSTS = ['cdn.jsdelivr.net', 'storage.googleapis.com'];

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    /* 1つ失敗しても全体を止めない */
    await Promise.allSettled(SHELL.map(u => cache.add(new Request(u, {cache:'reload'}))));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.map(k => {
      // 同じgithub.ioの他のアプリ（ジャンプ計測など）のキャッシュは消さない
      if ((k.startsWith('shell-cs30') || k.startsWith('cdn-cs30')) && k !== SHELL_CACHE && k !== CDN_CACHE) return caches.delete(k);
    }));
    await self.clients.claim();
  })());
});

self.addEventListener('message', e => {
  if (e.data === 'skipWaiting') self.skipWaiting();
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;

  let url;
  try { url = new URL(req.url); } catch (e) { return; }

  /* カメラ映像などのストリームは扱わない */
  if (url.protocol === 'blob:' || url.protocol === 'data:') return;

  /* MediaPipe などの外部配信: キャッシュ優先、無ければ取得して保存 */
  if (CDN_HOSTS.includes(url.hostname)) {
    event.respondWith((async () => {
      const cache = await caches.open(CDN_CACHE);
      const hit = await cache.match(req);
      if (hit) return hit;
      try {
        const res = await fetch(req);
        /* opaque レスポンスもそのまま保存しておく（CORS無しのwasm等） */
        if (res && (res.ok || res.type === 'opaque')) cache.put(req, res.clone());
        return res;
      } catch (err) {
        const any = await cache.match(req, {ignoreSearch:true});
        if (any) return any;
        throw err;
      }
    })());
    return;
  }

  /* 自サイト内 */
  if (url.origin === self.location.origin) {
    /* HTML はネット優先（更新をすぐ反映）、失敗したらキャッシュ */
    const isDoc = req.mode === 'navigate' ||
                  (req.headers.get('accept') || '').includes('text/html');
    if (isDoc) {
      event.respondWith((async () => {
        try {
          const res = await fetch(req);
          const cache = await caches.open(SHELL_CACHE);
          cache.put('./index.html', res.clone());
          return res;
        } catch (err) {
          const cache = await caches.open(SHELL_CACHE);
          return (await cache.match(req)) ||
                 (await cache.match('./index.html')) ||
                 new Response('オフラインです', {status:503, headers:{'Content-Type':'text/plain; charset=utf-8'}});
        }
      })());
      return;
    }
    /* それ以外の自サイト資産はキャッシュ優先 */
    event.respondWith((async () => {
      const cache = await caches.open(SHELL_CACHE);
      const hit = await cache.match(req);
      if (hit) return hit;
      try {
        const res = await fetch(req);
        if (res && res.ok) cache.put(req, res.clone());
        return res;
      } catch (err) {
        return hit || Response.error();
      }
    })());
  }
});
