// Trevo Gestão — service worker (app instalável)
const VERSAO = 'trevo-v1';
const LIBS = 'trevo-libs-v1';
const BASE = ['./', './index.html', './manifest.json', './icon-192.png', './icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSAO).then(c => c.addAll(BASE)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== VERSAO && k !== LIBS).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const u = new URL(req.url);
  // dados (Supabase), IA e bases de produtos: sempre direto da internet, nunca guardados
  if (/supabase\.co$|googleapis\.com$|facts\.org$/.test(u.hostname)) return;
  // arquivos do próprio app: tenta a internet primeiro (pega atualizações), usa o guardado se estiver sem rede
  if (u.origin === self.location.origin) {
    e.respondWith(fetch(req).then(r => {
      if (r.ok) { const cp = r.clone(); caches.open(VERSAO).then(c => c.put(req, cp)); }
      return r;
    }).catch(() => caches.match(req, { ignoreSearch: true }).then(r => r || caches.match('./index.html'))));
    return;
  }
  // bibliotecas (supabase, planilhas, OCR): guarda depois do primeiro uso
  if (/jsdelivr\.net$|unpkg\.com$|tessdata|projectnaptha\.com$/.test(u.hostname)) {
    e.respondWith(caches.open(LIBS).then(c => c.match(req).then(r => r || fetch(req).then(res => {
      if (res.ok) c.put(req, res.clone());
      return res;
    }))));
  }
});
