self.addEventListener('push', (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch (error) {
    console.error('Could not parse a Web Push notification.', error);
  }

  event.waitUntil((async () => {
    await self.registration.showNotification(payload.title || 'TaskerPH', {
      body: payload.body || 'You have a new update.',
      icon: '/apple-touch-icon.png',
      badge: '/apple-touch-icon.png',
      data: payload.data || {},
      tag: `taskerph-${payload.data?.task_id || 'update'}-${Date.now()}`
    });
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const existingClient = windows.find((client) => new URL(client.url).origin === self.location.origin);
    if (existingClient) {
      existingClient.postMessage({ type: 'taskerph:web-push-open', payload: data });
      await existingClient.focus();
      return;
    }
    const params = new URLSearchParams({ push: '1' });
    for (const key of ['type','task_id','other_user_id']) {
      if (data[key] != null) params.set(key,data[key]);
    }
    await self.clients.openWindow(`/?${params.toString()}`);
  })());
});
