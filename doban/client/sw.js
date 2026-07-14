// 도반글로벌 점주앱 서비스워커 — 설치 가능 + 앱 껍데기 오프라인 캐시
// 데이터(Supabase)는 절대 캐시 안 함 → 항상 최신
var CACHE = 'doban-client-v1';
var SHELL = ['./', './index.html', './icon-192.png', './icon-512.png', './manifest.webmanifest'];

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(SHELL).catch(function(){}); }));
  self.skipWaiting();
});

self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
  }));
  self.clients.claim();
});

self.addEventListener('fetch', function (e) {
  var url = e.request.url;
  // API/데이터 요청은 그냥 네트워크로 (캐시 금지 → 항상 최신)
  if (e.request.method !== 'GET' || url.indexOf('supabase.co') >= 0) return;
  // 앱 껍데기: 네트워크 우선(최신 배포 반영), 실패 시 캐시(오프라인)
  e.respondWith(
    fetch(e.request).then(function (res) {
      if (res && res.status === 200 && url.indexOf(self.location.origin) === 0) {
        var copy = res.clone(); caches.open(CACHE).then(function (c) { c.put(e.request, copy); });
      }
      return res;
    }).catch(function () {
      return caches.match(e.request).then(function (m) { return m || caches.match('./index.html'); });
    })
  );
});
