/* Service Worker do PDV · Caixa Rápido
   Estratégia: cache-first com atualização em segundo plano
   (stale-while-revalidate). Permite abrir e operar o app offline
   depois da primeira visita, sem servir HTML velho para sempre. */
const CACHE = "pdv-cache-v27";
const ASSETS = [
  "./",
  "./index.html",
  "./pdv-mobile.html",
  "./admin.html",
  "./css/pdv.css",
  "./js/config.js",
  "./js/cloud.js",
  "./js/helpers.js",
  "./js/store.js",
  "./js/feedback.js",
  "./js/auth.js",
  "./js/scanner.js",
  "./js/sale.js",
  "./js/search.js",
  "./js/backup.js",
  "./js/manager.js",
  "./js/dashboard.js",
  "./js/users.js",
  "./js/cashbox.js",
  "./js/modals.js",
  "./js/main.js",
  "./js/admin.js",
  "./pdv-core.js",
  "./qrcode.min.js",
  "./manifest.webmanifest",
  "./icon-192.png",
  "./icon-512.png",
  "./icon-maskable-512.png",
  "https://cdnjs.cloudflare.com/ajax/libs/html5-qrcode/2.3.8/html5-qrcode.min.js",
  "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.min.js"
];

self.addEventListener("install", e => {
  // add individual com catch: um asset que falhe não aborta a instalação
  e.waitUntil(
    caches.open(CACHE)
      .then(c => Promise.all(ASSETS.map(a => c.add(a).catch(() => {}))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET" || !req.url.startsWith("http")) return;
  e.respondWith((async () => {
    // HTML (navegação): rede primeiro, cache só como fallback offline.
    // Garante que um deploy novo apareça já na visita seguinte, em vez de
    // ficar preso no cache até uma segunda recarga.
    if (req.mode === "navigate" || req.destination === "document") {
      try {
        const res = await fetch(req);
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {});
        }
        return res;
      } catch (err) {
        const cached = await caches.match(req) || await caches.match("./pdv-mobile.html");
        if (cached) return cached;
        return new Response("Offline", { status: 503, statusText: "Offline" });
      }
    }
    const cached = await caches.match(req);
    // revalida em segundo plano: a próxima visita já pega a versão nova
    const network = fetch(req).then(res => {
      if (res && res.ok && (res.type === "basic" || res.type === "cors")) {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {});
      }
      return res;
    });
    if (cached) {
      network.catch(() => {}); // offline: silencia a revalidação e serve o cache
      return cached;
    }
    try {
      return await network;
    } catch (err) {
      // navegação offline sem cache exato: cai no shell do app
      if (req.mode === "navigate") {
        const shell = await caches.match("./pdv-mobile.html");
        if (shell) return shell;
      }
      return new Response("Offline", { status: 503, statusText: "Offline" });
    }
  })());
});
