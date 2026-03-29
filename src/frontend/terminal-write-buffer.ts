export type TerminalWriteChunk = string | Uint8Array;

export interface TerminalWriteBuffer {
  clear(): void;
  enqueue(chunk: TerminalWriteChunk): void;
  flush(): void;
}

const isEmptyChunk = (chunk: TerminalWriteChunk): boolean =>
  typeof chunk === "string" ? chunk.length === 0 : chunk.byteLength === 0;

const concatBinaryChunks = (chunks: Uint8Array[]): Uint8Array => {
  const totalBytes = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const combined = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return combined;
};

const collapseChunks = (chunks: TerminalWriteChunk[]): TerminalWriteChunk[] => {
  const collapsed: TerminalWriteChunk[] = [];
  let pendingText = "";
  let pendingBinary: Uint8Array[] = [];

  const flushText = (): void => {
    if (!pendingText) {
      return;
    }
    collapsed.push(pendingText);
    pendingText = "";
  };

  const flushBinary = (): void => {
    if (pendingBinary.length === 0) {
      return;
    }
    collapsed.push(pendingBinary.length === 1 ? pendingBinary[0]! : concatBinaryChunks(pendingBinary));
    pendingBinary = [];
  };

  for (const chunk of chunks) {
    if (typeof chunk === "string") {
      flushBinary();
      pendingText += chunk;
      continue;
    }
    flushText();
    pendingBinary.push(chunk);
  }

  flushText();
  flushBinary();
  return collapsed;
};

export const createTerminalWriteBuffer = (
  write: (chunk: TerminalWriteChunk) => void,
  requestFrame: (callback: () => void) => number = (callback) => requestAnimationFrame(callback),
  cancelFrame: (id: number) => void = (id) => cancelAnimationFrame(id)
): TerminalWriteBuffer => {
  let pending: TerminalWriteChunk[] = [];
  let frameId: number | null = null;

  const runFlush = (): void => {
    frameId = null;
    if (pending.length === 0) {
      return;
    }
    const chunks = pending;
    pending = [];
    for (const chunk of collapseChunks(chunks)) {
      write(chunk);
    }
  };

  return {
    clear(): void {
      pending = [];
      if (frameId !== null) {
        cancelFrame(frameId);
        frameId = null;
      }
    },
    enqueue(chunk: TerminalWriteChunk): void {
      if (isEmptyChunk(chunk)) {
        return;
      }
      pending.push(chunk);
      if (frameId !== null) {
        return;
      }
      frameId = requestFrame(runFlush);
    },
    flush(): void {
      if (frameId !== null) {
        cancelFrame(frameId);
        frameId = null;
      }
      runFlush();
    }
  };
};
