export class EvalRequestTimeoutError extends Error {
  constructor(
    readonly label: string,
    readonly timeoutMs: number,
  ) {
    super(`eval request timed out after ${timeoutMs}ms: ${label}`);
    this.name = "EvalRequestTimeoutError";
  }
}

const MAX_EVAL_REQUEST_TIMEOUT_MS = 10 * 60_000;

export function parseEvalTimeoutMs(
  value: string | boolean | undefined,
  fallback = 60_000,
): number {
  if (value === undefined) return fallback;
  const timeoutMs = typeof value === "string" ? Number(value) : Number.NaN;
  if (
    !Number.isFinite(timeoutMs) ||
    timeoutMs <= 0 ||
    timeoutMs > MAX_EVAL_REQUEST_TIMEOUT_MS
  ) {
    throw new Error(
      `eval timeout must be between 1 and ${MAX_EVAL_REQUEST_TIMEOUT_MS}ms: ${String(value)}`,
    );
  }
  return timeoutMs;
}

/** Bounds one network-backed eval operation and propagates the same abort signal into it. */
export async function withEvalDeadline<T>(
  label: string,
  timeoutMs: number,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  if (
    !Number.isFinite(timeoutMs) ||
    timeoutMs <= 0 ||
    timeoutMs > MAX_EVAL_REQUEST_TIMEOUT_MS
  ) {
    throw new Error(
      `eval timeout must be between 1 and ${MAX_EVAL_REQUEST_TIMEOUT_MS}ms: ${timeoutMs}`,
    );
  }
  const controller = new AbortController();
  const timeoutError = new EvalRequestTimeoutError(label, timeoutMs);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort(timeoutError);
      reject(timeoutError);
    }, timeoutMs);
  });
  try {
    const running = operation(controller.signal).catch((error: unknown) => {
      if (controller.signal.aborted) throw timeoutError;
      throw error;
    });
    return await Promise.race([running, deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
