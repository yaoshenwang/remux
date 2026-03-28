export interface WebSocketProbeHandle {
  close(): void;
}

export interface WebSocketProbeHandlers {
  onError(error: unknown): void;
  onOpen(): void;
}

export type WebSocketProbeFactory = (
  url: string,
  handlers: WebSocketProbeHandlers,
) => WebSocketProbeHandle;

export interface ResolvePreferredWebSocketOriginOptions {
  publicOrigin: string;
  preferredLoopbackOrigin?: string;
  probeFactory?: WebSocketProbeFactory;
  timeoutMs?: number;
}

const normalizeOrigin = (value: string): string => value.replace(/\/+$/, "");

const defaultProbeFactory: WebSocketProbeFactory = (url, handlers) => {
  const socket = new WebSocket(url);
  socket.onopen = () => handlers.onOpen();
  socket.onerror = (error) => handlers.onError(error);
  return {
    close: () => {
      if (socket.readyState === socket.CONNECTING || socket.readyState === socket.OPEN) {
        socket.close();
      }
    },
  };
};

export const resolvePreferredWebSocketOrigin = async ({
  publicOrigin,
  preferredLoopbackOrigin,
  probeFactory = defaultProbeFactory,
  timeoutMs = 300,
}: ResolvePreferredWebSocketOriginOptions): Promise<string> => {
  if (!preferredLoopbackOrigin) {
    return publicOrigin;
  }

  const normalizedPublicOrigin = normalizeOrigin(publicOrigin);
  const normalizedPreferredOrigin = normalizeOrigin(preferredLoopbackOrigin);
  if (!normalizedPreferredOrigin || normalizedPreferredOrigin === normalizedPublicOrigin) {
    return normalizedPublicOrigin;
  }

  return await new Promise((resolve) => {
    const probe = probeFactory(`${normalizedPreferredOrigin}/ws/control`, {
      onOpen: () => {
        clearTimeout(timeout);
        probe.close();
        resolve(normalizedPreferredOrigin);
      },
      onError: () => {
        clearTimeout(timeout);
        probe.close();
        resolve(normalizedPublicOrigin);
      },
    });
    const timeout = setTimeout(() => {
      probe.close();
      resolve(normalizedPublicOrigin);
    }, timeoutMs);
  });
};
