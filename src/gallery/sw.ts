export const swJS = /* js */ `
const SHELL = "shotsync-shell-v1";
// Cache the app shell on install so the navigate fallback below actually works offline.
self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.add("/")).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  // Drop stale shell caches from older versions, then take control.
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== SHELL).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  // Do not intercept auth requests; leave auth to page JS
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/i/")) return;
  if (e.request.mode === "navigate") {
    e.respondWith(fetch(e.request).catch(() => caches.match("/")));
  }
});
`;
