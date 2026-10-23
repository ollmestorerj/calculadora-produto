// Este domínio não usa mais notificações push.
// Navegadores que ainda têm o service worker antigo instalado baixam este
// arquivo, que se remove sozinho e limpa os caches.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const nomes = await caches.keys();
    await Promise.all(nomes.map((n) => caches.delete(n)));
    await self.registration.unregister();
  })());
});
