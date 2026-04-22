export async function sleep(ms: number): Promise<void> {
  if (!Number.isFinite(ms) || ms <= 0) return;
  await new Promise((resolve) => setTimeout(resolve, Math.floor(ms)));
}

export async function retryAsync<T>(
  fn: (attempt: number) => Promise<T>,
  opts: {
    attempts: number;
    baseDelayMs?: number;
    backoffFactor?: number;
    shouldRetry?: (err: unknown, attempt: number) => boolean;
  }
): Promise<T> {
  const attempts = Math.max(1, Math.floor(Number(opts.attempts || 1)));
  const baseDelayMs = Math.max(0, Math.floor(Number(opts.baseDelayMs ?? 0)));
  const backoffFactor = Number(opts.backoffFactor ?? 2);

  let lastErr: unknown = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastErr = err;
      const canRetry = attempt < attempts && (opts.shouldRetry ? opts.shouldRetry(err, attempt) : true);
      if (!canRetry) throw err;

      const delay = baseDelayMs > 0 ? Math.round(baseDelayMs * Math.pow(backoffFactor, attempt - 1)) : 0;
      if (delay > 0) await sleep(delay);
    }
  }

  throw lastErr ?? new Error('retryAsync exhausted attempts');
}
