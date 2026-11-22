import type { PagePromise } from "./pagination.js";

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/** One API call, as the generated resource methods describe it. */
export interface RequestSpec {
  method: HttpMethod;
  /** Path with its parameters already filled in and encoded, e.g. `/api/posts/123`. */
  path: string;
  query?: object;
  body?: unknown;
  /** The operation takes an `Idempotency-Key` header. */
  idempotent?: boolean;
}

export interface RequestOptions {
  /** Cancels the request, including retries and waits between them. */
  signal?: AbortSignal;
  /** Per-attempt timeout. Default: the client's `timeoutMs`. */
  timeoutMs?: number;
  /** Default: the client's `maxRetries`. */
  maxRetries?: number;
  /** Extra headers for this request. */
  headers?: Record<string, string>;
}

export interface IdempotentRequestOptions extends RequestOptions {
  /**
   * Sent as `Idempotency-Key`. The same key with the same request returns the first result instead of
   * acting twice (kept 24 hours). Without one, the SDK generates a key per call and reuses it on retries.
   * Pass your own to stay safe across process restarts, for example a hash of the content you post.
   */
  idempotencyKey?: string;
}

/** A list response: one page of `data` plus offset pagination. */
export interface ListResponse {
  data: unknown[];
  pagination: { limit: number; offset: number; total: number; hasMore: boolean };
}

export interface Transport {
  request<T>(spec: RequestSpec, options?: IdempotentRequestOptions): Promise<T>;
  paginate<T extends ListResponse>(spec: RequestSpec, options?: RequestOptions): PagePromise<T>;
}

export function encodePathParam(value: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`Expected a non-empty string path parameter, got ${JSON.stringify(value)}`);
  }
  return encodeURIComponent(value);
}
