/* 312th Airlift ACARS: the service worker that makes the page installable as an app.
   - The page itself always comes from the network first, so a new version shows up as soon as you are online. The saved copy is only used when there is no connection.
   - The printer server (any /api/ address, or any other website) is never touched: those requests go straight through, so prints and PINs are never cached or delayed. */
const VERSION = "V116";
const CACHE = "acars-" + VERSION;
const SHELL = ["./", "./index.html", "./manifest.webmanifest", "./apple-touch-icon.png", "./icon-192.png", "./icon-512.png", "./icon-maskable.png"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => Promise.all(SHELL.map(u => c.add(u).catch(() => null)))).then(() => self.skipWaiting()));
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k.startsWith("acars-") && k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || url.pathname.includes("/api/")) return;       // not ours: leave it alone
  const isPage = req.mode === "navigate" || /\/(index\.html)?$/.test(url.pathname);
  if (isPage){
    e.respondWith((async () => {
      const cache = await caches.open(CACHE);
      try {
        const fresh = await Promise.race([fetch(req, {cache: "no-store"}), new Promise((_, no) => setTimeout(() => no(new Error("slow")), 6000))]);
        if (fresh && fresh.ok) cache.put("./index.html", fresh.clone());
        return fresh;
      } catch (err) {
        return (await cache.match("./index.html")) || (await cache.match("./")) || Response.error();
      }
    })());
    return;
  }
  e.respondWith(caches.match(req).then(hit => hit || fetch(req).then(r => { if (r && r.ok) caches.open(CACHE).then(c => c.put(req, r.clone())); return r; })));
});
