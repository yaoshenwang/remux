const terminalTextEncoder = new TextEncoder();

const encodeTerminalChunk = (chunk: string): Uint8Array => terminalTextEncoder.encode(chunk);

export interface TerminalInputBatcher {
  bufferWhileDisconnected: (data: string) => void;
  clear: () => void;
  enqueue: (data: string) => void;
  flushBufferedInput: () => void;
  getBufferedLength: () => number;
}

export const createTerminalInputBatcher = (
  sendPayload: (payload: Uint8Array) => boolean,
): TerminalInputBatcher => {
  let bufferedDisconnectedInput = "";
  let pendingBatch = "";
  let flushScheduled = false;
  let generation = 0;

  const flushPendingBatch = (scheduledGeneration: number): void => {
    if (scheduledGeneration !== generation) {
      return;
    }
    flushScheduled = false;
    if (!pendingBatch) {
      return;
    }

    const batch = pendingBatch;
    pendingBatch = "";
    if (!sendPayload(encodeTerminalChunk(batch))) {
      bufferedDisconnectedInput += batch;
    }
  };

  const scheduleFlush = (): void => {
    if (flushScheduled) {
      return;
    }
    flushScheduled = true;
    const scheduledGeneration = generation;
    queueMicrotask(() => {
      flushPendingBatch(scheduledGeneration);
    });
  };

  return {
    bufferWhileDisconnected(data: string) {
      bufferedDisconnectedInput += data;
    },
    clear() {
      generation += 1;
      bufferedDisconnectedInput = "";
      pendingBatch = "";
      flushScheduled = false;
    },
    enqueue(data: string) {
      pendingBatch += data;
      scheduleFlush();
    },
    flushBufferedInput() {
      if (!bufferedDisconnectedInput) {
        return;
      }
      const buffered = bufferedDisconnectedInput;
      if (sendPayload(encodeTerminalChunk(buffered))) {
        bufferedDisconnectedInput = "";
      }
    },
    getBufferedLength() {
      return bufferedDisconnectedInput.length + pendingBatch.length;
    },
  };
};
