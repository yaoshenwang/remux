self.addEventListener("push", (event) => {
  const payload = event?.data ? event.data.json() : {};
  const title = payload.title ?? "Remux Notification";
  const options = {
    body: payload.body ?? "",
    tag: payload.tag,
    data: payload.data ?? {},
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const relativeUrl = event.notification.data?.url ?? "/";
  const targetUrl = new URL(relativeUrl, self.location.origin).toString();

  event.waitUntil((async () => {
    const clientList = await self.clients.matchAll({
      type: "window",
      includeUncontrolled: true,
    });

    for (const client of clientList) {
      if ("focus" in client) {
        await client.navigate(targetUrl);
        await client.focus();
        return;
      }
    }

    await self.clients.openWindow(targetUrl);
  })());
});
