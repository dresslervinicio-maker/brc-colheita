// Service Worker do BRC — Colheita e Comercialização
// Fica registrado no navegador do produtor e roda em segundo plano, mesmo com o site fechado.
// É essa peça que efetivamente recebe o push do servidor e mostra a notificação no aparelho.

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
  let dados = { title: 'BRC - Colheita', body: 'Você tem uma nova notificação.', url: '/' };
  try {
    if (event.data) dados = Object.assign(dados, event.data.json());
  } catch (e) {
    // se não vier em JSON, usa o texto puro como corpo da notificação
    if (event.data) dados.body = event.data.text();
  }

  const opcoes = {
    body: dados.body,
    icon: './icon-192.png',
    badge: './icon-192.png',
    data: { url: dados.url || '/' },
    vibrate: [120, 60, 120],
  };

  event.waitUntil(self.registration.showNotification(dados.title, opcoes));
});

// Ao tocar na notificação, abre (ou foca) a aba do sistema
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const urlAlvo = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((janelas) => {
      for (const janela of janelas) {
        if ('focus' in janela) return janela.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow(urlAlvo);
    })
  );
});
