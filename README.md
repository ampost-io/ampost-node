# Ampost Node.js SDK

The official TypeScript and JavaScript client for the [Ampost API](https://ampost.io/docs?ref=github):
publish, schedule and track posts on Instagram, Facebook, Threads, X, YouTube, Pinterest, Bluesky,
Telegram and Discord with one call.

- Typed requests and responses for every endpoint, generated from the [OpenAPI document](https://api.ampost.io/openapi.json)
- Retries on 429 and 5xx with `Retry-After`, automatic `Idempotency-Key`s, typed errors
- `for await` pagination and a one-call media upload
- No runtime dependencies. ESM and CommonJS, Node 18+

## Install

```sh
npm install ampost
```

## Quick start

Create an API key in [Setup → API keys](https://ampost.io/app/settings/api-keys?ref=github), connect
Bluesky and Threads in the [dashboard](https://ampost.io/app?ref=github), then:

```ts
import { Ampost } from "ampost";

const ampost = new Ampost({ apiKey: process.env.AMPOST_API_KEY });

const post = await ampost.posts.create({
  text: "Hello from the Ampost API 👋",
  targets: [{ platforms: ["bluesky", "threads"] }],
  publishNow: true,
});
console.log(post.id, post.status, post.platformPosts.map((p) => `${p.platform}: ${p.status}`));
```

Leave out `publishNow` for a draft, or set `scheduledFor: "2026-12-01T09:00:00Z"` to schedule it
(paid plans). CommonJS works the same: `const { Ampost } = require("ampost")`.

## Authentication

Every request sends the key as `Authorization: Bearer <key>`. Without `apiKey` the client reads
`AMPOST_API_KEY`, and `AMPOST_BASE_URL` overrides `https://api.ampost.io`.

```ts
const ampost = new Ampost({
  apiKey: "amp_...",
  maxRetries: 2,        // after a 429, a 5xx or a network error
  timeoutMs: 60_000,    // per attempt
});
```

A key has scopes (`posts:write`, `analytics:read`, ...) and can be limited to some platform sets. A
call outside them fails with `PermissionDeniedError` and `code: "INSUFFICIENT_SCOPE"` or
`"PLATFORM_SET_NOT_ALLOWED"`. See [scopes](https://ampost.io/docs?ref=github#scopes).

## Errors

Every API error is `{ error: { code, message, details } }`, thrown as a subclass of `APIError`:

```ts
import { APIError, BadRequestError, RateLimitError } from "ampost";

try {
  await ampost.posts.create({ text: "x".repeat(500), targets: [{ platforms: ["bluesky"] }] });
} catch (error) {
  if (error instanceof BadRequestError) console.log(error.code, error.details); // CONTENT_TOO_LONG, ...
  else if (error instanceof RateLimitError) console.log(`retry in ${error.retryAfterSeconds} s`);
  else if (error instanceof APIError) console.log(error.status, error.code, error.requestId);
  else throw error;
}
```

| Status | Class | Typical `code` |
| ------ | ----- | -------------- |
| 400 | `BadRequestError` | `VALIDATION_FAILED`, `CONTENT_TOO_LONG`, `PLATFORM_NOT_CONNECTED` |
| 401 | `AuthenticationError` | `UNAUTHORIZED` |
| 403 | `PermissionDeniedError` | `INSUFFICIENT_SCOPE`, `UPGRADE_REQUIRED`, `PLATFORM_COMING_SOON` |
| 404 | `NotFoundError` | `POST_NOT_FOUND`, `ACCOUNT_NOT_FOUND` |
| 409 | `ConflictError` | `INVALID_STATUS_TRANSITION`, `IDEMPOTENCY_KEY_REUSED` |
| 413 | `PayloadTooLargeError` | `PAYLOAD_TOO_LARGE` |
| 422 | `UnprocessableEntityError` | `ANALYTICS_NOT_AVAILABLE_ON_PLATFORM` |
| 429 | `RateLimitError` | `RATE_LIMITED`, `QUOTA_EXCEEDED` |
| 5xx | `InternalServerError` | `INTERNAL_ERROR`, `PLATFORM_REQUEST_FAILED` |

No response at all is `APIConnectionError` (`APITimeoutError` after `timeoutMs`). All of them extend
`AmpostError`. Quote `error.requestId` when you contact support. Every code is listed in
[the docs](https://ampost.io/docs?ref=github#errors).

A post that was accepted can still fail on one platform: check `post.platformPosts[].status` and
`.error`, or subscribe to [webhooks](https://ampost.io/docs?ref=github#webhooks).

## Idempotency

`posts.create`, `posts.publish`, `posts.retry`, `posts.importCsv`, `accounts.connect`,
`platformSets.create`, `webhooks.create` and `feedback.submit` take an `Idempotency-Key`. The SDK
sends a new key with each call and keeps it across that call's retries, so a retried request never
posts twice. To stay safe across restarts too (a cron job, a queue worker), pass your own key:

```ts
await ampost.posts.create(
  { text: "v1.4.0 is out", targets: [{ platforms: ["bluesky"] }], publishNow: true },
  { idempotencyKey: "release-v1.4.0" },
);
```

The same key with the same request returns the first result for 24 hours; with a different request
it is `ConflictError` `IDEMPOTENCY_KEY_REUSED`. See
[idempotency](https://ampost.io/docs?ref=github#idempotency).

## Retries

| What happened | Retried? |
| ------------- | -------- |
| 429 `RATE_LIMITED`, `QUOTA_EXCEEDED` | Yes, after `Retry-After`, if it is under `maxRetryDelayMs` (60 s) |
| 409 `IDEMPOTENCY_REQUEST_IN_PROGRESS` | Yes |
| 5xx, timeout, network error | Reads and calls with an `Idempotency-Key` only |
| Anything else | No |

Waits without `Retry-After` back off from 0.5 s to 8 s. Set `maxRetries` on the client or per call:
`ampost.posts.get(id, { maxRetries: 0 })`. Every method also takes `signal`, `timeoutMs` and `headers`.

## Pagination

List methods return a page you can await, or iterate to get every item:

```ts
const { data, pagination } = await ampost.posts.list({ status: "failed", limit: 50 });

for await (const post of ampost.posts.list({ status: "failed" })) {
  await ampost.posts.retry(post.id);
}

const accounts = await ampost.accounts.list().toArray();
```

## Media upload

`media.upload()` takes a path, a `Blob`/`File` or bytes, sends the file straight to storage (your API
key is not sent there), waits until Ampost has checked it and returns a `media` item:

```ts
const video = await ampost.media.upload("./launch.mp4");
await ampost.posts.create({
  text: "We launched 🚀",
  media: [video],
  targets: [{ platforms: ["youtube", "threads"] }],
  options: { youtube: { title: "Launch day" } },
});
```

Public URLs work without an upload: `media: [{ url: "https://example.com/a.jpg", type: "image" }]`.
For files on a user's device, show `uploadPageUrl` from `media.createUpload()` and call
`media.waitForUpload(id)`. See [media upload](https://ampost.io/docs?ref=github#media-upload).

## Everything else

Each tag of the API is a property: `posts`, `accounts`, `platformSets` (and posting queues),
`media`, `analytics`, `webhooks`, `platforms`, `docs`, `feedback`. Types for every request and response
are exported by name:

```ts
import type { Post, PostsCreateBody, AnalyticsOverview } from "ampost";
```

`ampost.platforms.list()` returns each platform's limits and options, and `ampost.posts.validate(body)`
checks a post without creating it.

AI agents can use the same API through the hosted MCP server at `https://api.ampost.io/mcp`
([setup](https://ampost.io/docs/mcp?ref=github)).

## Development

The typed layer in `src/generated/` comes from `openapi.json`; never edit it by hand.

```sh
npm ci
npm run generate                                                  # from the committed openapi.json
npm run generate -- --spec https://api.ampost.io/openapi.json     # refresh the snapshot, then generate
npm run typecheck && npm test && npm run build
AMPOST_API_KEY=amp_... npm run test:smoke                         # reads and validates only
```

`npm run check` regenerates and fails if anything changed, as CI does.

Why this generator: [openapi-typescript](https://openapi-ts.dev) turns the spec into types only, with
no runtime. A short script (`scripts/generate.mjs`) adds one method per operation on top, and the
hand-written client (`src/client.ts`) adds auth, retries, idempotency, errors and pagination. The
published package has no dependencies and its methods read like the API docs.

## Links

- [API docs](https://ampost.io/docs?ref=github) and [llms.txt](https://ampost.io/llms.txt?ref=github)
- [MCP server](https://ampost.io/docs/mcp?ref=github)
- [Pricing](https://ampost.io/pricing?ref=github)
- [Python SDK](https://github.com/ampost-io/ampost-python) and [Ruby SDK](https://github.com/ampost-io/ampost-ruby)

## License

MIT
