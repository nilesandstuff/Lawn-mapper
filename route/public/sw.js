/**
 * The route planner's service worker (route session, 2026-11-06): only for
 * notifications. A push arrives empty (src/push.js); this asks the Worker
 * what to say, shows it, and opens the route when it is tapped.
 */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('push', (e) => e.waitUntil((async () => {
  let msg = { title: 'Route update', body: 'Your route changed. Open it to see.', url: '/', tag: 'route' };
  try {
    const sub = await self.registration.pushManager.getSubscription();
    const res = await fetch(`/api/push/latest?endpoint=${encodeURIComponent(sub.endpoint)}`, { cache: 'no-store' });
    if (res.ok) msg = { ...msg, ...(await res.json()) };
  } catch { /* the plain message */ }
  await self.registration.showNotification(msg.title, {
    body: msg.body, tag: msg.tag, renotify: true, icon: '/apple-touch-icon.png', badge: '/favicon-32.png', data: { url: msg.url },
  });
})()));

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil((async () => {
    const url = new URL(e.notification.data?.url || '/', self.location.origin).href;
    const open = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of open) if (c.url === url && 'focus' in c) return c.focus();
    return self.clients.openWindow(url);
  })());
});
