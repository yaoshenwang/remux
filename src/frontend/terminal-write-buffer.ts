export type TerminalWriteChunk = string | Uint8Array;
export interface TerminalWriteOptions {
  atomic?: boolean;
  beforeWrite?: () => void;
  onComplete?: () => void;
}

export interface TerminalWriteBuffer {
  clear(): void;
  enqueue(chunk: TerminalWriteChunk, options?: TerminalWriteOptions | (() => void)): void;
  flush(): void;
}

export interface TerminalWriteBufferOptions {
  maxBytesPerFrame?: number;
  now?: () => number;
  maxFrameMs?: number;
}

type TerminalWriteCallback = () => void;
type TerminalWriteSink = (chunk: TerminalWriteChunk, onWritten: TerminalWriteCallback) => void;
type PendingWrite = {
  atomic: boolean;
  chunk: TerminalWriteChunk;
  beforeWrite?: () => void;
  beforeWritePending: boolean;
  onComplete?: () => void;
  offset: number;
};

const isEmptyChunk = (chunk: TerminalWriteChunk): boolean =>
  typeof chunk === "string" ? chunk.length === 0 : chunk.byteLength === 0;

const textEncoder = new TextEncoder();

const getChunkByteLength = (chunk: TerminalWriteChunk): number =>
  typeof chunk === "string" ? textEncoder.encode(chunk).byteLength : chunk.byteLength;

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

const mergePendingWrites = (
  current: PendingWrite | undefined,
  next: PendingWrite,
): PendingWrite | null => {
  if (
    !current
    || current.atomic
    || next.atomic
    || current.beforeWrite
    || next.beforeWrite
    || current.onComplete
    || next.onComplete
    || current.offset !== 0
    || next.offset !== 0
  ) {
    return null;
  }
  if (typeof current.chunk === "string" && typeof next.chunk === "string") {
    return {
      atomic: false,
      beforeWritePending: false,
      chunk: current.chunk + next.chunk,
      offset: 0,
    };
  }
  if (current.chunk instanceof Uint8Array && next.chunk instanceof Uint8Array) {
    return {
      atomic: false,
      beforeWritePending: false,
      chunk: concatBinaryChunks([current.chunk, next.chunk]),
      offset: 0,
    };
  }
  return null;
};

const getRemainingBytes = (write: PendingWrite): number => {
  if (typeof write.chunk === "string") {
    return getChunkByteLength(write.chunk.slice(write.offset));
  }
  return write.chunk.byteLength - write.offset;
};

const normalizeWriteOptions = (
  options?: TerminalWriteOptions | (() => void),
): TerminalWriteOptions => {
  if (typeof options === "function") {
    return { onComplete: options };
  }
  return options ?? {};
};

const takeSlice = (
  write: PendingWrite,
  maxBytes: number,
): { chunk: TerminalWriteChunk; bytes: number; done: boolean } => {
  if (typeof write.chunk === "string") {
    const remaining = write.chunk.slice(write.offset);
    const nextChunk = remaining.slice(0, Math.max(1, maxBytes));
    const bytes = getChunkByteLength(nextChunk);
    return {
      chunk: nextChunk,
      bytes,
      done: write.offset + nextChunk.length >= write.chunk.length,
    };
  }

  const nextChunk = write.chunk.subarray(write.offset, write.offset + Math.max(1, maxBytes));
  return {
    chunk: nextChunk,
    bytes: nextChunk.byteLength,
    done: write.offset + nextChunk.byteLength >= write.chunk.byteLength,
  };
};

export const createTerminalWriteBuffer = (
  write: TerminalWriteSink,
  requestFrame: (callback: () => void) => number = (callback) => requestAnimationFrame(callback),
  cancelFrame: (id: number) => void = (id) => cancelAnimationFrame(id),
  options: TerminalWriteBufferOptions = {},
): TerminalWriteBuffer => {
  let pending: PendingWrite[] = [];
  let frameId: number | null = null;
  let writeInFlight = false;
  let generation = 0;
  let frameBudgetRemaining = 0;
  let frameDeadline = 0;
  const maxBytesPerFrame = Math.max(1, Math.floor(options.maxBytesPerFrame ?? (64 * 1024)));
  const maxFrameMs = Math.max(0, options.maxFrameMs ?? 6);
  const now = options.now ?? (() => (
    typeof performance !== "undefined" && typeof performance.now === "function"
      ? performance.now()
      : Date.now()
  ));

  const scheduleDrain = (): void => {
    if (frameId !== null || writeInFlight || pending.length === 0) {
      return;
    }
    frameId = requestFrame(runFlush);
  };

  const pumpWrites = (scheduledGeneration: number): void => {
    if (scheduledGeneration !== generation || writeInFlight || pending.length === 0) {
      return;
    }
    if (frameBudgetRemaining <= 0 || (maxFrameMs > 0 && now() >= frameDeadline)) {
      scheduleDrain();
      return;
    }

    const nextWrite = pending[0]!;
    const slice = takeSlice(
      nextWrite,
      nextWrite.atomic ? getRemainingBytes(nextWrite) : frameBudgetRemaining,
    );
    frameBudgetRemaining = Math.max(0, frameBudgetRemaining - slice.bytes);
    if (nextWrite.beforeWritePending) {
      nextWrite.beforeWritePending = false;
      nextWrite.beforeWrite?.();
    }
    writeInFlight = true;
    write(slice.chunk, () => {
      writeInFlight = false;
      if (scheduledGeneration !== generation) {
        return;
      }
      nextWrite.offset += typeof slice.chunk === "string" ? slice.chunk.length : slice.chunk.byteLength;
      if (slice.done) {
        pending.shift();
        nextWrite.onComplete?.();
      }
      if (pending.length === 0) {
        return;
      }
      if (frameBudgetRemaining <= 0 || (maxFrameMs > 0 && now() >= frameDeadline)) {
        scheduleDrain();
        return;
      }
      pumpWrites(scheduledGeneration);
    });
  };

  const runFlush = (): void => {
    frameId = null;
    if (pending.length === 0 || writeInFlight) {
      return;
    }
    frameBudgetRemaining = maxBytesPerFrame;
    frameDeadline = now() + maxFrameMs;
    pumpWrites(generation);
  };

  const flushImmediately = (scheduledGeneration: number): void => {
    if (frameId !== null) {
      cancelFrame(frameId);
      frameId = null;
    }
    if (writeInFlight) {
      return;
    }
    frameBudgetRemaining = Number.MAX_SAFE_INTEGER;
    frameDeadline = Number.POSITIVE_INFINITY;
    pumpWrites(scheduledGeneration);
  };

  return {
    clear(): void {
      generation += 1;
      pending = [];
      if (frameId !== null) {
        cancelFrame(frameId);
        frameId = null;
      }
    },
    enqueue(chunk: TerminalWriteChunk, options?: TerminalWriteOptions | (() => void)): void {
      if (isEmptyChunk(chunk)) {
        normalizeWriteOptions(options).onComplete?.();
        return;
      }
      const normalizedOptions = normalizeWriteOptions(options);
      const nextWrite: PendingWrite = {
        atomic: normalizedOptions.atomic === true,
        chunk,
        beforeWrite: normalizedOptions.beforeWrite,
        beforeWritePending: Boolean(normalizedOptions.beforeWrite),
        onComplete: normalizedOptions.onComplete,
        offset: 0,
      };
      const previous = pending[pending.length - 1];
      const merged = mergePendingWrites(previous, nextWrite);
      if (merged) {
        pending[pending.length - 1] = merged;
      } else {
        pending.push(nextWrite);
      }
      scheduleDrain();
    },
    flush(): void {
      flushImmediately(generation);
    }
  };
};
