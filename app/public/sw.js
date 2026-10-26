// Offline shell for the Nokor Pass PWA. The API is never cached: a payment,
// entry or cash-out must reach the Worker or fail visibly.
const CACHE = "nokor-pass-v1";
const SHELL = "/index.html";

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches
      .open(CACHE)
      .then((c) => c.addAll([SHELL, "/icon.svg", "/manifest.webmanifest"]))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

async function networkFirst(request) {
  try {
    const res = await fetch(request);
    const cache = await caches.open(CACHE);
    await cache.put(SHELL, res.clone());
    return res;
  } catch {
    const hit = await caches.match(SHELL);
    if (hit) return hit;
    throw new Error("offline");
  }
}

async function cacheFirst(request) {
  const hit = await caches.match(request);
  if (hit) return hit;
  const res = await fetch(request);
  if (res.ok && res.type === "basic") {
    const cache = await caches.open(CACHE);
    await cache.put(request, res.clone());
  }
  return res;
}

self.addEventListener("fetch", (e) => {
  const { request } = e;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return;

  // Navigations go to the network first so a new build is picked up at once.
  // Vite's assets are content-hashed, so a cache hit for them is always current.
  e.respondWith(request.mode === "navigate" ? networkFirst(request) : cacheFirst(request));
});
