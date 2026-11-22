/** Base class of every error the SDK throws. */
export class AmpostError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = new.target.name;
    if (options && "cause" in options) (this as { cause?: unknown }).cause = options.cause;
  }
}

/**
 * The API answered with an error status. The body is `{ error: { code, message, details } }`:
 * `code` is stable (for example `VALIDATION_FAILED`, `POST_NOT_FOUND`); the full list is at
 * https://ampost.io/docs?ref=github#errors.
 */
export class APIError extends AmpostError {
  readonly status: number;
  readonly code: string;
  readonly details: Record<string, unknown> | undefined;
  /** `X-Request-Id`: quote it when you contact support. */
  readonly requestId: string | undefined;
  readonly headers: Headers;

  constructor(status: number, code: string, message: string, details: Record<string, unknown> | undefined, headers: Headers) {
    super(`${status} ${code}: ${message}`);
    this.status = status;
    this.code = code;
    this.details = details;
    this.headers = headers;
    this.requestId = headers.get("x-request-id") ?? undefined;
  }

  /** Builds the subclass that matches the status. */
  static from(status: number, body: unknown, headers: Headers, statusText = ""): APIError {
    const { code, message, details } = parseErrorBody(status, body, statusText);
    const Class = errorClassFor(status);
    return new Class(status, code, message, details, headers);
  }
}

/** 400: the request is invalid (`VALIDATION_FAILED`, `CONTENT_TOO_LONG`, ...). `details.issues` lists the problems. */
export class BadRequestError extends APIError {}
/** 401: the API key is missing, wrong or revoked. */
export class AuthenticationError extends APIError {}
/** 403: the key lacks a scope, the plan lacks a feature, or the account is suspended. */
export class PermissionDeniedError extends APIError {}
/** 404: no such resource belongs to you. */
export class NotFoundError extends APIError {}
/** 409: the resource's state does not allow it, or an idempotency key was reused. */
export class ConflictError extends APIError {}
/** 413: the request body is too large; upload files with `client.media.upload()`. */
export class PayloadTooLargeError extends APIError {}
/** 422: the request is well formed but cannot be done (for example analytics on Discord). */
export class UnprocessableEntityError extends APIError {}

/** 429: `RATE_LIMITED` or `QUOTA_EXCEEDED`. Retried automatically when `Retry-After` is short. */
export class RateLimitError extends APIError {
  /** Seconds the API asked to wait (`Retry-After`). */
  get retryAfterSeconds(): number | undefined {
    const seconds = parseRetryAfter(this.headers.get("retry-after"));
    return seconds === undefined ? undefined : Math.ceil(seconds / 1000);
  }
}

/** 5xx: something failed on Ampost's side or at a platform. */
export class InternalServerError extends APIError {}

/** No response: DNS, TCP, TLS or a reset connection. */
export class APIConnectionError extends AmpostError {}

/** No response within `timeoutMs`. */
export class APITimeoutError extends APIConnectionError {}

/** `client.media.upload()` did not end with a usable file. */
export class MediaUploadError extends AmpostError {
  constructor(
    message: string,
    /** `upload_rejected`: the file PUT failed; `failed`/`expired`: the upload's status; `timeout`: still pending. */
    readonly reason: "failed" | "expired" | "timeout" | "upload_rejected",
    readonly uploadId: string,
  ) {
    super(message);
  }
}

function errorClassFor(status: number): typeof APIError {
  if (status === 400) return BadRequestError;
  if (status === 401) return AuthenticationError;
  if (status === 403) return PermissionDeniedError;
  if (status === 404) return NotFoundError;
  if (status === 409) return ConflictError;
  if (status === 413) return PayloadTooLargeError;
  if (status === 422) return UnprocessableEntityError;
  if (status === 429) return RateLimitError;
  if (status >= 500) return InternalServerError;
  return APIError;
}

function parseErrorBody(status: number, body: unknown, statusText: string) {
  const fallback = { code: `HTTP_${status}`, message: statusText || "Request failed", details: undefined };
  if (!body || typeof body !== "object" || !("error" in body)) {
    return typeof body === "string" && body.trim() ? { ...fallback, message: body.trim().slice(0, 500) } : fallback;
  }
  const error = (body as { error: unknown }).error;
  // A few edge routes answer `{ error: "message" }`.
  if (typeof error === "string") return { ...fallback, message: error };
  if (!error || typeof error !== "object") return fallback;
  const { code, message, details } = error as { code?: unknown; message?: unknown; details?: unknown };
  return {
    code: typeof code === "string" ? code : fallback.code,
    message: typeof message === "string" ? message : fallback.message,
    details: details && typeof details === "object" ? (details as Record<string, unknown>) : undefined,
  };
}

/** `Retry-After` in milliseconds: delta-seconds or an HTTP date. */
export function parseRetryAfter(value: string | null, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (/^\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed) * 1000;
  const date = Date.parse(trimmed);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}
