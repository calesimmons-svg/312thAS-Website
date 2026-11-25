/* 312th Airlift ACARS Archive: service worker (v5)
   - Keeps the app shell so it opens instantly / offline.
   - Receives a push from the archive Worker whenever a new print lands, counts the
     unread prints, shows a notification and puts the number on the home-screen icon. */
const API = "https://acars-archive.cale-simmons.workers.dev";
const SHELL = "arch-shell-v5";   /* prefix "arch-", NOT "acars-": the main ACARS app's service worker deletes every "acars-*" cache that is not its own */
const FILES = ["./", "index.html", "manifest.webmanifest", "apple-touch-icon.png", "icon-192.png", "icon-512.png"];
const STATE = "arch-state-v1";   /* shared with the page: the time of the newest print you have seen */

self.addEventListener("install", e => {
  e.waitUntil(caches.open(SHELL).then(c => c.addAll(FILES)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys()
    .then(ks => Promise.all(ks.filter(k => k.startsWith("arch-shell-") && k !== SHELL).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

/* Network first, fall back to the saved copy. Only this app's own files; the data API is never cached here. */
self.addEventListener("fetch", e => {
  const r = e.request;
  if (r.method !== "GET") return;
  const u = new URL(r.url);
  if (u.origin !== location.origin) return;
  e.respondWith(
    fetch(r).then(res => {
      if (res.ok) { const copy = res.clone(); caches.open(SHELL).then(c => c.put(r, copy)); }
      return res;
    }).catch(() => caches.match(r).then(m => m || caches.match("index.html")))
  );
});

async function stateGet(k) {
  try { const r = await (await caches.open(STATE)).match("/__state/" + k); return r ? await r.json() : null; } catch (_) { return null; }
}

function describe(p) {
  if (!p) return "";
  if (p.photo) return "New picture print" + (p.to ? " (" + p.to + ")" : "");
  return "TO " + (p.to || "?") + ": " + (p.msg || "") + (p.from ? " - " + p.from : "");
}

async function onPush() {
  let n = 0, latest = null;
  try {
    const last = await stateGet("lastSeen");
    const r = await fetch(API + "/prints?limit=50&order=new", { cache: "no-store" });
    const list = (await r.json()).prints || [];
    latest = list[0] || null;
    n = last && last.at ? list.filter(p => p.at > last.at).length : (list.length ? 1 : 0);
  } catch (_) {}

  const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  const visible = wins.some(w => w.visibilityState === "visible");
  wins.forEach(w => w.postMessage("push"));      /* an open page refreshes itself and clears the badge */

  let body;
  if (n === 0) body = "Notifications are on. You're all caught up.";
  else if (n === 1) body = describe(latest);
  else body = n + " new prints. Latest: " + describe(latest);

  /* iOS requires every push to show a notification */
  await self.registration.showNotification("312th ACARS", {
    body: body.slice(0, 160), tag: "acars-new", renotify: true,
    icon: "icon-192.png", data: { url: "./" }
  });
  if (!visible && n > 0 && self.navigator && self.navigator.setAppBadge) {
    try { await self.navigator.setAppBadge(Math.min(n, 99)); } catch (_) {}
  }
}
self.addEventListener("push", e => e.waitUntil(onPush()));

self.addEventListener("notificationclick", e => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(ws =>
    ws.length ? ws[0].focus() : self.clients.openWindow("./")));
});
