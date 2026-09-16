const CACHE='tree-meister-quotes-v1';
const ASSETS=['./','./index.html','./app.js','./manifest.webmanifest'];
self.addEventListener('install',event=>event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(ASSETS))));
self.addEventListener('activate',event=>event.waitUntil(self.clients.claim()));
self.addEventListener('fetch',event=>event.respondWith(caches.match(event.request).then(resp=>resp||fetch(event.request))));
