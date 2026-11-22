import type { IdempotentRequestOptions, ListResponse, RequestOptions, RequestSpec } from "./core.js";
import { AmpostError, APIConnectionError, APIError, APITimeoutError, parseRetryAfter } from "./errors.js";
import { AmpostResources } from "./generated/resources.js";
import { MediaResource } from "./media.js";
import { PagePromise } from "./pagination.js";
import { VERSION } from "./version.js";

export const DEFAULT_BASE_URL = "https://api.ampost.io";

export interface ClientOptions {
  /** An API key from https://ampost.io/app/settings/api-keys. Default: `process.env.AMPOST_API_KEY`. */
  apiKey?: string;
  /** Default: `process.env.AMPOST_BASE_URL`, else `https://api.ampost.io`. */
  baseUrl?: string;
  /** Retries after a 429, a 5xx or a network error (see README, "Retries"). Default 2. */
  maxRetries?: number;
  /** Per-attempt timeout in milliseconds. Default 60 000. */
  timeoutMs?: number;
  /** A `Retry-After` longer than this is not waited for: the error is thrown. Default 60 000. */
  maxRetryDelayMs?: number;
  /** Headers sent with every request. */
  defaultHeaders?: Record<string, string>;
  /** Custom fetch, for proxies or tests. Default: the global `fetch` (Node 18+). */
  fetch?: typeof fetch;
}

/** A finished HTTP exchange with the body already read. */
export interface RawResponse {
  status: number;
  statusText: string;
  ok: boolean;
  headers: Headers;
  text: string;
}

const env = (name: string): string | undefined =>
  typeof process === "undefined" ? undefined : process.env?.[name] || undefined;

/**
 * The Ampost API client.
 *
 *   import { Ampost } from "ampost";
 *   const client = new Ampost(); // reads AMPOST_API_KEY
 *   const post = await client.posts.create({ text: "Hello", targets: [{ platforms: ["bluesky"] }], publishNow: true });
 */
export class Ampost extends AmpostResources {
  /** Media uploads, with `upload()` on top of the generated methods. */
  override readonly media: MediaResource;
  readonly baseUrl: string;
  readonly maxRetries: number;
  readonly timeoutMs: number;
  readonly maxRetryDelayMs: number;
  readonly #apiKey: string;
  readonly #defaultHeaders: Record<string, string>;
  readonly #fetch: typeof fetch;

  constructor(options: ClientOptions = {}) {
    super();
    const apiKey = options.apiKey ?? env("AMPOST_API_KEY");
    if (!apiKey) {
      throw new AmpostError(
        "Missing API key: pass { apiKey } or set AMPOST_API_KEY. Create one at https://ampost.io/app/settings/api-keys?ref=github",
      );
    }
    const fetchImpl = options.fetch ?? globalThis.fetch;
    if (typeof fetchImpl !== "function") throw new AmpostError("No fetch available: use Node 18+ or pass { fetch }");
    this.#apiKey = apiKey;
    this.#fetch = fetchImpl;
    this.#defaultHeaders = { ...options.defaultHeaders };
    this.baseUrl = (options.baseUrl ?? env("AMPOST_BASE_URL") ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.maxRetries = options.maxRetries ?? 2;
    this.timeoutMs = options.timeoutMs ?? 60_000;
    this.maxRetryDelayMs = options.maxRetryDelayMs ?? 60_000;
    this.media = new MediaResource(this, (url, init, requestOptions) => this.send(url, init, requestOptions));
  }

  /**
   * Sends one API call with auth, the idempotency key and retries. The generated methods call this;
   * use it directly only for an endpoint this SDK version does not know yet.
   */
  async request<T>(spec: RequestSpec, options: IdempotentRequestOptions = {}): Promise<T> {
    const headers: Record<string, string> = {
      Accept: "application/json",
      "User-Agent": `ampost-node/${VERSION}`,
      ...this.#defaultHeaders,
      ...options.headers,
      Authorization: `Bearer ${this.#apiKey}`,
    };
    let body: string | undefined;
    if (spec.body !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(spec.body);
    }
    if (spec.idempotent) headers["Idempotency-Key"] = options.idempotencyKey ?? randomKey();
    // Without a key, a write that timed out may have been done: only reads and keyed writes repeat.
    const repeatable = spec.method === "GET" || spec.idempotent === true;
    const maxRetries = options.maxRetries ?? this.maxRetries;
    const url = buildUrl(this.baseUrl, spec.path, spec.query);

    for (let attempt = 0; ; attempt++) {
      let response: RawResponse;
      try {
        response = await this.send(url, { method: spec.method, headers, body }, options);
      } catch (error) {
        if (!(error instanceof APIConnectionError) || !repeatable || attempt >= maxRetries) throw error;
        await sleep(backoff(attempt), options.signal);
        continue;
      }

      if (response.ok) return parseJson<T>(response);

      const error = APIError.from(response.status, parseMaybeJson(response.text), response.headers, response.statusText);
      const delay = this.retryDelay(error, attempt, repeatable);
      if (delay === undefined || attempt >= maxRetries) throw error;
      await sleep(delay, options.signal);
    }
  }

  /** Like `request`, for list operations: returns a page that also iterates every item. */
  paginate<T extends ListResponse>(spec: RequestSpec, options?: RequestOptions): PagePromise<T> {
    return new PagePromise<T>((offset) =>
      this.request<T>(offset === undefined ? spec : { ...spec, query: { ...spec.query, offset } }, options),
    );
  }

  /** Milliseconds to wait before retrying, or undefined to give up. */
  private retryDelay(error: APIError, attempt: number, repeatable: boolean): number | undefined {
    const retryable =
      error.status === 429 || // refused before anything ran
      error.code === "IDEMPOTENCY_REQUEST_IN_PROGRESS" || // the first request with this key still runs
      ((error.status >= 500 || error.status === 408) && repeatable);
    if (!retryable) return undefined;
    const retryAfter = parseRetryAfter(error.headers.get("retry-after"));
    if (retryAfter === undefined) return backoff(attempt);
    // A quota reset days away is not worth blocking on.
    return retryAfter <= this.maxRetryDelayMs ? retryAfter : undefined;
  }

  /** @internal One HTTP exchange with the timeout; reads the body. Throws APIConnectionError without a response. */
  async send(url: string, init: RequestInit, options: RequestOptions = {}): Promise<RawResponse> {
    const { signal } = options;
    if (signal?.aborted) throw abortReason(signal);
    const controller = new AbortController();
    const timeoutMs = options.timeoutMs ?? this.timeoutMs;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    const onAbort = () => controller.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const response = await this.#fetch(url, { ...init, signal: controller.signal });
      const text = await response.text();
      return { status: response.status, statusText: response.statusText, ok: response.ok, headers: response.headers, text };
    } catch (error) {
      if (signal?.aborted) throw abortReason(signal);
      if (timedOut) throw new APITimeoutError(`Request timed out after ${timeoutMs} ms`, { cause: error });
      throw new APIConnectionError(`Connection error: ${error instanceof Error ? error.message : String(error)}`, {
        cause: error,
      });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }
}

export function buildUrl(baseUrl: string, path: string, query?: object): string {
  const url = new URL(`${baseUrl}${path}`);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === undefined || value === null) continue;
    for (const item of Array.isArray(value) ? value : [value]) {
      url.searchParams.append(key, item instanceof Date ? item.toISOString() : String(item));
    }
  }
  return url.toString();
}

function parseMaybeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function parseJson<T>(response: RawResponse): T {
  if (!response.text) return undefined as T;
  try {
    return JSON.parse(response.text) as T;
  } catch (error) {
    throw new AmpostError(`Expected JSON from the API, got: ${response.text.slice(0, 200)}`, { cause: error });
  }
}

/** Exponential backoff with jitter: about 0.5 s, 1 s, 2 s, ... up to 8 s. */
export function backoff(attempt: number): number {
  const base = Math.min(500 * 2 ** attempt, 8_000);
  return Math.round(base * (0.75 + Math.random() * 0.5));
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The operation was aborted", "AbortError");
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortReason(signal));
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortReason(signal!));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** A UUID v4 for `Idempotency-Key`; Node 18 has no global `crypto` without a flag, hence the fallback. */
export function randomKey(): string {
  const webCrypto = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (webCrypto?.randomUUID) return webCrypto.randomUUID();
  const hex = Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16));
  hex[12] = "4";
  hex[16] = ((parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  const s = hex.join("");
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}
