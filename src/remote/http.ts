export interface RequestUrlResponse {
  status: number;
  text: string;
  arrayBuffer: ArrayBuffer;
  json: unknown;
  headers: Record<string, string>;
}

export type RequestUrlFn = (req: {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  throw?: boolean;
}) => Promise<RequestUrlResponse>;

export interface RemoteClientConfig {
  baseUrl: string;
  projectId: string;
  token: string;
  timeoutMs?: number;
  maxRateLimitRetries?: number;
  sleep?: (ms: number) => Promise<void>;
  onRateLimitWait?: (info: { waitMs: number; attempt: number; maxAttempts: number }) => void;
}

/** Looks up a response header by name without regard to casing. */
export function getHeaderCaseInsensitive(
  headers: Record<string, string>,
  name: string,
): string | undefined {
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === target) {
      return value;
    }
  }
  return undefined;
}

/** Computes retry wait duration (ms) from Retry-After, RateLimit-Reset, or exponential backoff. */
export function parseRateLimitDelayMs(headers: Record<string, string>, attempt: number): number {
  let delayMs: number | undefined;

  const rawRetryAfter = getHeaderCaseInsensitive(headers, 'retry-after')?.trim();
  if (rawRetryAfter) {
    const seconds = Number(rawRetryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) {
      delayMs = Math.ceil(seconds * 1000) + 250;
    } else {
      const parsedDate = Date.parse(rawRetryAfter);
      if (Number.isFinite(parsedDate)) {
        delayMs = parsedDate - Date.now() + 250;
      }
    }
  }

  if (delayMs === undefined) {
    const rawReset = (
      getHeaderCaseInsensitive(headers, 'ratelimit-reset') ??
      getHeaderCaseInsensitive(headers, 'x-ratelimit-reset')
    )?.trim();
    if (rawReset) {
      const epochSec = Number(rawReset);
      if (Number.isFinite(epochSec)) {
        delayMs = Math.ceil(epochSec * 1000 - Date.now()) + 500;
      }
    }
  }

  if (delayMs !== undefined && Number.isFinite(delayMs)) {
    return Math.min(65_000, Math.max(1_000, delayMs));
  }

  return Math.min(60_000, 5_000 * 2 ** (attempt - 1));
}

/**
 * Executes an HTTP request via Obsidian's `requestUrl`-compatible function with explicit
 * timeout enforcement, `{ cause }` error chaining, and configurable rate-limit retries.
 */
export async function sendRemoteRequest(opts: {
  requestFn: RequestUrlFn;
  url: string;
  label: string;
  headers: Record<string, string>;
  method?: string;
  body?: string;
  timeoutMs: number;
  maxRateLimitRetries: number;
  sleep: (ms: number) => Promise<void>;
  shouldRetryRateLimit?: (res: RequestUrlResponse) => boolean;
  onRateLimitWait?: RemoteClientConfig['onRateLimitWait'];
}): Promise<RequestUrlResponse> {
  const method = opts.method ?? 'GET';

  for (let attempt = 0; attempt <= opts.maxRateLimitRetries; attempt++) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    let res: RequestUrlResponse;
    try {
      const timeoutPromise = new Promise<never>((_resolve, reject) => {
        timer = window.setTimeout(() => {
          timedOut = true;
          reject(new Error(`${opts.label} timed out after ${opts.timeoutMs}ms`));
        }, opts.timeoutMs);
      });
      res = await Promise.race([
        opts.requestFn({
          url: opts.url,
          method,
          headers: opts.headers,
          ...(opts.body !== undefined ? { body: opts.body } : {}),
          throw: false,
        }),
        timeoutPromise,
      ]);
    } catch (err) {
      if (timedOut) {
        throw err;
      }
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`${opts.label} request failed: ${message}`, { cause: err });
    } finally {
      if (timer !== undefined) {
        window.clearTimeout(timer);
      }
    }

    const isRateLimit = opts.shouldRetryRateLimit
      ? opts.shouldRetryRateLimit(res)
      : res.status === 429;
    if (isRateLimit && attempt < opts.maxRateLimitRetries) {
      const waitMs = parseRateLimitDelayMs(res.headers ?? {}, attempt + 1);
      opts.onRateLimitWait?.({
        waitMs,
        attempt: attempt + 1,
        maxAttempts: opts.maxRateLimitRetries,
      });
      await opts.sleep(waitMs);
      continue;
    }

    return res;
  }

  throw new Error(`${opts.label} exceeded max rate-limit retries`);
}
