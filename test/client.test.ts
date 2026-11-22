import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  Ampost,
  AmpostError,
  APIConnectionError,
  APITimeoutError,
  AuthenticationError,
  BadRequestError,
  ConflictError,
  InternalServerError,
  NotFoundError,
  PermissionDeniedError,
  RateLimitError,
  VERSION,
} from "../src/index.js";
import { apiError, json, mockClient } from "./helpers.js";

const POST = { id: "7b0c2b9e-4a59-4f3e-9e0a-2b6a1d1f6c11", status: "draft" };

describe("requests", () => {
  it("sends the key as a Bearer token, JSON and the SDK user agent", async () => {
    const { client, calls } = mockClient([json(201, POST)]);
    const post = await client.posts.create({ text: "Hello", targets: [{ platforms: ["bluesky", "threads"] }] });
    assert.deepEqual(post, POST);
    const [call] = calls;
    assert.equal(call!.method, "POST");
    assert.equal(call!.url.toString(), "https://api.ampost.io/api/posts");
    assert.equal(call!.headers.get("authorization"), "Bearer amp_test_key");
    assert.equal(call!.headers.get("content-type"), "application/json");
    assert.equal(call!.headers.get("user-agent"), `ampost-node/${VERSION}`);
    assert.deepEqual(call!.body, { text: "Hello", targets: [{ platforms: ["bluesky", "threads"] }] });
  });

  it("serializes the query and leaves out undefined values", async () => {
    const { client, calls } = mockClient([json(200, { data: [], pagination: { limit: 5, offset: 0, total: 0, hasMore: false } })]);
    await client.posts.list({ status: "failed", limit: 5, search: undefined });
    assert.equal(calls[0]!.url.search, "?status=failed&limit=5");
  });

  it("encodes path parameters", async () => {
    const { client, calls } = mockClient([json(200, POST)]);
    await client.posts.get("a/b c");
    assert.equal(calls[0]!.url.pathname, "/api/posts/a%2Fb%20c");
  });

  it("uses baseUrl and AMPOST_API_KEY / AMPOST_BASE_URL from the environment", async () => {
    process.env.AMPOST_API_KEY = "amp_env_key";
    process.env.AMPOST_BASE_URL = "http://localhost:3000/";
    try {
      let seen: Request | undefined;
      const client = new Ampost({
        fetch: (async (url: string, init: RequestInit) => {
          seen = new Request(url, init);
          return json(200, POST);
        }) as typeof fetch,
      });
      await client.posts.get("p1");
      assert.equal(seen!.url, "http://localhost:3000/api/posts/p1");
      assert.equal(seen!.headers.get("authorization"), "Bearer amp_env_key");
    } finally {
      delete process.env.AMPOST_API_KEY;
      delete process.env.AMPOST_BASE_URL;
    }
  });

  it("refuses to start without a key", () => {
    delete process.env.AMPOST_API_KEY;
    assert.throws(() => new Ampost(), (error: unknown) => error instanceof AmpostError && /AMPOST_API_KEY/.test(error.message));
  });

  it("does not show the key when the client is logged", async () => {
    const { client } = mockClient([]);
    const { inspect } = await import("node:util");
    assert.doesNotMatch(inspect(client, { depth: 3 }), /amp_test_key/);
    assert.doesNotMatch(JSON.stringify(Object.keys(client)), /apiKey/);
  });
});

describe("idempotency", () => {
  it("generates a key for idempotent operations and keeps it across retries", async () => {
    const { client, calls } = mockClient([apiError(503, "INTERNAL_ERROR"), json(201, POST)]);
    await client.posts.create({ text: "Hi", targets: [{ platforms: ["bluesky"] }] });
    assert.equal(calls.length, 2);
    const key = calls[0]!.headers.get("idempotency-key");
    assert.match(key!, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.equal(calls[1]!.headers.get("idempotency-key"), key);
  });

  it("sends the caller's key", async () => {
    const { client, calls } = mockClient([json(201, POST)]);
    await client.posts.create({ text: "Hi", targets: [{ platforms: ["bluesky"] }] }, { idempotencyKey: "release-v1.2.0" });
    assert.equal(calls[0]!.headers.get("idempotency-key"), "release-v1.2.0");
  });

  it("gives each call its own generated key", async () => {
    const { client, calls } = mockClient([json(201, POST), json(201, POST)]);
    await client.posts.publish("p1");
    await client.posts.publish("p1");
    assert.notEqual(calls[0]!.headers.get("idempotency-key"), calls[1]!.headers.get("idempotency-key"));
  });

  it("sends no key on operations without one", async () => {
    const { client, calls } = mockClient([json(200, POST)]);
    await client.posts.update("p1", { text: "New" });
    assert.equal(calls[0]!.headers.get("idempotency-key"), null);
  });

  it("waits while the first request with the key still runs", async () => {
    const { client, calls } = mockClient([
      apiError(409, "IDEMPOTENCY_REQUEST_IN_PROGRESS", "Still running", undefined, { "retry-after": "0" }),
      json(201, POST),
    ]);
    await client.posts.create({ text: "Hi", targets: [{ platforms: ["bluesky"] }] }, { idempotencyKey: "k-1" });
    assert.equal(calls.length, 2);
  });
});

describe("retries", () => {
  it("retries a 429 after Retry-After, even for a write without a key", async () => {
    const { client, calls } = mockClient([
      apiError(429, "RATE_LIMITED", "Slow down", { retryAfterSeconds: 0 }, { "retry-after": "0" }),
      json(200, { valid: true }),
    ]);
    const result = await client.posts.validate({ text: "Hi", targets: [{ platforms: ["bluesky"] }] });
    assert.deepEqual(result, { valid: true });
    assert.equal(calls.length, 2);
  });

  it("does not wait for a Retry-After longer than maxRetryDelayMs", async () => {
    const { client, calls } = mockClient([apiError(429, "QUOTA_EXCEEDED", "Used up", undefined, { "retry-after": "86400" })]);
    await assert.rejects(client.posts.list(), (error: unknown) => {
      assert.ok(error instanceof RateLimitError);
      assert.equal(error.code, "QUOTA_EXCEEDED");
      assert.equal(error.retryAfterSeconds, 86400);
      return true;
    });
    assert.equal(calls.length, 1);
  });

  it("retries a 5xx on a GET", async () => {
    const { client, calls } = mockClient([apiError(502, "PLATFORM_REQUEST_FAILED"), json(200, POST)], { maxRetries: 1 });
    await client.posts.get("p1");
    assert.equal(calls.length, 2);
  });

  it("does not repeat a write without an idempotency key after a 5xx", async () => {
    const { client, calls } = mockClient([apiError(500, "INTERNAL_ERROR", "Boom")]);
    await assert.rejects(client.posts.update("p1", { text: "x" }), InternalServerError);
    assert.equal(calls.length, 1);
  });

  it("retries network errors on reads and gives up after maxRetries", async () => {
    const { client, calls } = mockClient([new TypeError("fetch failed"), new TypeError("fetch failed")], { maxRetries: 1 });
    await assert.rejects(client.accounts.list(), (error: unknown) => {
      assert.ok(error instanceof APIConnectionError);
      assert.match(error.message, /fetch failed/);
      return true;
    });
    assert.equal(calls.length, 2);
  });

  it("honours maxRetries: 0 per request", async () => {
    const { client, calls } = mockClient([apiError(503, "INTERNAL_ERROR")]);
    await assert.rejects(client.posts.get("p1", { maxRetries: 0 }), InternalServerError);
    assert.equal(calls.length, 1);
  });
});

describe("errors", () => {
  const cases: [number, string, new (...args: never[]) => Error][] = [
    [400, "VALIDATION_FAILED", BadRequestError],
    [401, "UNAUTHORIZED", AuthenticationError],
    [403, "INSUFFICIENT_SCOPE", PermissionDeniedError],
    [404, "POST_NOT_FOUND", NotFoundError],
    [409, "INVALID_STATUS_TRANSITION", ConflictError],
  ];
  for (const [status, code, Class] of cases) {
    it(`maps ${status} to ${Class.name}`, async () => {
      const { client } = mockClient([
        apiError(status, code, "Explained", { issues: [{ path: ["text"] }] }, { "x-request-id": "req_123" }),
      ]);
      await assert.rejects(client.posts.update("p1", { text: "" }), (error: unknown) => {
        assert.ok(error instanceof Class);
        assert.ok(error instanceof AmpostError);
        const apiErr = error as unknown as { status: number; code: string; details: unknown; requestId: string; message: string };
        assert.equal(apiErr.status, status);
        assert.equal(apiErr.code, code);
        assert.deepEqual(apiErr.details, { issues: [{ path: ["text"] }] });
        assert.equal(apiErr.requestId, "req_123");
        assert.equal(apiErr.message, `${status} ${code}: Explained`);
        return true;
      });
    });
  }

  it("reads `{ error: string }` and non-JSON bodies", async () => {
    const { client } = mockClient([json(401, { error: "Invalid API key" }), new Response("<html>Bad gateway</html>", { status: 400 })]);
    await assert.rejects(client.posts.get("p1"), (error: unknown) => {
      assert.ok(error instanceof AuthenticationError);
      assert.equal(error.code, "HTTP_401");
      assert.equal(error.message, "401 HTTP_401: Invalid API key");
      return true;
    });
    await assert.rejects(client.posts.get("p1"), (error: unknown) => error instanceof BadRequestError && /Bad gateway/.test(error.message));
  });

  it("throws APITimeoutError when no response comes in time", async () => {
    const hang = (_: unknown, init: RequestInit) =>
      new Promise<Response>((_, reject) => init.signal!.addEventListener("abort", () => reject(new Error("aborted"))));
    const client = new Ampost({ apiKey: "k", maxRetries: 0, timeoutMs: 20, fetch: hang as unknown as typeof fetch });
    await assert.rejects(client.posts.get("p1"), APITimeoutError);
  });

  it("passes the caller's abort through without retrying", async () => {
    const controller = new AbortController();
    let attempts = 0;
    const fetchImpl = ((_: unknown, init: RequestInit) => {
      attempts++;
      controller.abort(new Error("caller gave up"));
      return Promise.reject(init.signal!.reason);
    }) as unknown as typeof fetch;
    const client = new Ampost({ apiKey: "k", fetch: fetchImpl });
    await assert.rejects(client.posts.get("p1", { signal: controller.signal }), /caller gave up/);
    assert.equal(attempts, 1);
  });
});
